import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { authRequired } from "../middleware/auth";
import { requireRole } from "../middleware/requireRole";

export const adminUsersRoutes = Router();

/**
 * Helpers
 */
async function getStacksForUsers(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string[]>();

  const { rows } = await pool.query(
    `SELECT uds.user_id, ds.code
     FROM user_developer_stacks uds
     JOIN developer_stacks ds ON ds.id = uds.stack_id
     WHERE uds.user_id = ANY($1::uuid[])
     ORDER BY ds.id`,
    [userIds]
  );

  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.user_id) ?? [];
    arr.push(r.code);
    map.set(r.user_id, arr);
  }
  return map;
}

async function setUserStacks(userId: string, stacks: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [userId]);

    for (const code of stacks) {
      const stackIdRes = await client.query(`SELECT id FROM developer_stacks WHERE code = $1`, [code]);
      const stackId = stackIdRes.rows[0]?.id;
      if (!stackId) throw new Error(`Stack inválida: ${code}`);

      await client.query(
        `INSERT INTO user_developer_stacks (user_id, stack_id) VALUES ($1, $2)`,
        [userId, stackId]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Schema
 */
const RoleSchema = z.enum(["user", "manager", "developer", "admin"]);
const StackSchema = z.array(z.enum(["frontend", "backend", "infra"])).default([]);

/**
 * GET /api/admin/users
 * Retorna { items: User[] } no formato que o front espera.
 */
adminUsersRoutes.get(
  "/admin/users",
  authRequired,
  requireRole(["admin"]),
  async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, created_at, is_active, deleted_at
       FROM users
       ORDER BY created_at DESC`
    );

    const ids = rows.map((r) => r.id);
    const stacksMap = await getStacksForUsers(ids);

    const items = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      stacks: stacksMap.get(u.id) ?? [],
      created_at: u.created_at,
	  is_active: u.is_active,
		deleted_at: u.deleted_at,
    }));

    return res.json({ items });
  }
);

/**
 * GET /api/admin/users/:userId
 */
adminUsersRoutes.get(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;

    const userRes = await pool.query(
      `SELECT id, name, email, role, created_at, is_active, deleted_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const stacksMap = await getStacksForUsers([userId]);

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      stacks: stacksMap.get(userId) ?? [],
      created_at: user.created_at,
    });
  }
);

/**
 * POST /api/admin/users
 * body: { name, email, role, password, stacks? }
 *
 * - password obrigatório na criação
 * - stacks opcionais (só faz sentido para developer/admin)
 */
adminUsersRoutes.post(
  "/admin/users",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(200),
      role: RoleSchema,
      password: z.string().min(6).max(200),
      stacks: StackSchema.optional(),
    }).parse(req.body);

    const password_hash = await bcrypt.hash(body.password, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertRes = await client.query(
        `INSERT INTO users (name, email, role, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, role, created_at`,
        [body.name, body.email, body.role, password_hash]
      );

      const user = insertRes.rows[0];

      const stacks = body.stacks ?? [];
      // se for user/manager, stacks devem ficar vazias
      const finalStacks = (body.role === "developer" || body.role === "admin") ? stacks : [];

      await client.query("COMMIT");

      // stacks fora da transação (ou dentro, tanto faz) — aqui vou fazer fora usando helper:
      if (finalStacks.length > 0) {
        await setUserStacks(user.id, finalStacks);
      } else {
        await pool.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [user.id]);
      }

      return res.status(201).json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        stacks: finalStacks,
        created_at: user.created_at,
      });
    } catch (e: any) {
      await client.query("ROLLBACK");
      // email unique
      if (String(e?.code) === "23505") {
        return res.status(409).json({ error: "E-mail já cadastrado" });
      }
      throw e;
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /api/admin/users/:userId
 * body: { name?, email?, role?, password?, stacks? }
 *
 * - password opcional (se vier, atualiza hash)
 * - stacks atualizáveis (admin decide)
 */
adminUsersRoutes.patch(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;

    const BodySchema = z
      .object({
        name: z.string().min(2).optional(),
        email: z.string().email().optional(),
        role: z.enum(["user", "manager", "developer", "admin"]).optional(), // ✅ inclui manager
        password: z.string().min(6).optional(),
        stacks: StackSchema.optional(),
      })
      .refine((v) => Object.keys(v).length > 0, { message: "Nada para atualizar" });

    let body: z.infer<typeof BodySchema>;
    try {
      body = BodySchema.parse(req.body);
    } catch (e: any) {
      return res.status(400).json({ error: e.errors?.[0]?.message || "Payload inválido" });
    }

    // valida usuário existe
    const exists = await pool.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (exists.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 🔐 senha (opcional) -> coluna CERTA: password_hash
      if (body.password) {
        const hash = await bcrypt.hash(body.password, 10);
        await client.query(
          `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
          [hash, userId]
        );
      }

      // 👤 dados básicos (name/email/role)
      if (body.name || body.email || body.role) {
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (body.name) {
          fields.push(`name = $${idx++}`);
          values.push(body.name);
        }
        if (body.email) {
          fields.push(`email = $${idx++}`);
          values.push(body.email);
        }
        if (body.role) {
          fields.push(`role = $${idx++}`);
          values.push(body.role);
        }

        values.push(userId);

        await client.query(
          `UPDATE users SET ${fields.join(", ")}, updated_at = now() WHERE id = $${idx}`,
          values
        );
      }

      // 🧩 stacks (somente se veio no payload)
      // regra: stacks só fazem sentido para developer/admin; caso role vire user/manager => limpa stacks
      const roleRes = await client.query(`SELECT role FROM users WHERE id = $1`, [userId]);
      const currentRole = roleRes.rows[0].role as string;

      if (body.stacks !== undefined) {
        const finalStacks = (currentRole === "developer" || currentRole === "admin") ? body.stacks : [];

        // limpa relação correta
        await client.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [userId]);

        for (const code of finalStacks) {
          const stackRes = await client.query(
            `SELECT id FROM developer_stacks WHERE code = $1`,
            [code]
          );
          if (stackRes.rowCount === 0) throw new Error(`Stack inválida: ${code}`);

          await client.query(
            `INSERT INTO user_developer_stacks (user_id, stack_id) VALUES ($1, $2)`,
            [userId, stackRes.rows[0].id]
          );
        }
      } else if (currentRole !== "developer" && currentRole !== "admin") {
        // se não mandou stacks mas virou user/manager, garante limpeza
        await client.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [userId]);
      }

      await client.query("COMMIT");

      // ✅ retorna o USER atualizado (o front precisa disso)
      const userRes = await pool.query(
        `SELECT id, name, email, role, created_at FROM users WHERE id = $1`,
        [userId]
      );

      const stacksRes = await pool.query(
        `SELECT ds.code
         FROM user_developer_stacks uds
         JOIN developer_stacks ds ON ds.id = uds.stack_id
         WHERE uds.user_id = $1
         ORDER BY ds.code`,
        [userId]
      );

      return res.json({
        id: userRes.rows[0].id,
        name: userRes.rows[0].name,
        email: userRes.rows[0].email,
        role: userRes.rows[0].role,
        stacks: stacksRes.rows.map((r) => r.code),
        created_at: userRes.rows[0].created_at,
      });
    } catch (e: any) {
      await client.query("ROLLBACK");
      if (String(e?.code) === "23505") {
        return res.status(409).json({ error: "E-mail já cadastrado" });
      }
      console.error("PATCH /admin/users error:", e);
      return res.status(400).json({ error: e.message || "Erro ao atualizar usuário" });
    } finally {
      client.release();
    }
  }
);


/**
 * DELETE /api/admin/users/:userId
 * (cascata: memberships + stacks + votes etc., depende das FKs; aqui só deletamos o user)
 */
adminUsersRoutes.delete(
  "/admin/users/:userId",
  authRequired,
  requireRole(["admin"]),
  async (req, res) => {
    const { userId } = req.params;
    const adminId = req.auth!.userId;

    // opcional: impedir admin de se auto-desativar
    if (userId === adminId) {
      return res.status(400).json({ error: "Você não pode remover seu próprio usuário" });
    }

    const upd = await pool.query(
      `UPDATE users
       SET is_active = false,
           deleted_at = now(),
           deleted_by_user_id = $1,
           updated_at = now()
       WHERE id = $2 AND is_active = true
       RETURNING id`,
      [adminId, userId]
    );

    if (upd.rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });

    return res.json({ ok: true });
  }
);
