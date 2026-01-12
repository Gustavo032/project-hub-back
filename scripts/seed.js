/* scripts/seed.js */
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não definido no .env");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function uuid() {
  // gera uuid v4 sem lib (bom o suficiente pra seed)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function upsertUser({ id, name, email, role, password, stacks = [] }) {
  const password_hash = await bcrypt.hash(password, 10);

  // Tenta inserir. Se já existir por email, atualiza e RETORNA o id existente.
  const { rows } = await pool.query(
    `INSERT INTO users (id, name, email, role, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email)
     DO UPDATE SET
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       password_hash = EXCLUDED.password_hash,
       updated_at = now()
     RETURNING id`,
    [id, name, email, role, password_hash]
  );

  const realUserId = rows[0].id;

  // stacks (limpa e reinsere) usando o id REAL
  await pool.query(`DELETE FROM user_developer_stacks WHERE user_id = $1`, [realUserId]);

  for (const code of stacks) {
    const stackIdRes = await pool.query(`SELECT id FROM developer_stacks WHERE code=$1`, [code]);
    const stackId = stackIdRes.rows[0]?.id;
    if (!stackId) throw new Error(`Stack inválida: ${code}`);

    await pool.query(`INSERT INTO user_developer_stacks (user_id, stack_id) VALUES ($1, $2)`, [
      realUserId,
      stackId,
    ]);
  }

  return realUserId;
}


async function upsertProject({ id, name, description, created_by_user_id }) {
  await pool.query(
    `INSERT INTO projects (id, name, description, status, created_by_user_id)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (id)
     DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, updated_at=now()`,
    [id, name, description, created_by_user_id]
  );
}

async function addMember(project_id, user_id) {
  await pool.query(
    `INSERT INTO project_members (project_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [project_id, user_id]
  );
}

async function createSuggestion({
  id,
  project_id,
  created_by_user_id,
  title,
  description,
  status = "open",
}) {
  const { rows } = await pool.query(
    `INSERT INTO suggestions
      (id, project_id, created_by_user_id, title, description, status, progress_percent)
     VALUES ($1, $2, $3, $4, $5, $6, 0)
     ON CONFLICT (id)
     DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, status=EXCLUDED.status, updated_at=now()
     RETURNING id`,
    [id, project_id, created_by_user_id, title, description, status]
  );
  return rows[0].id;
}

async function upsertVote({ project_id, suggestion_id, user_id, vote }) {
  await pool.query(
    `INSERT INTO suggestion_votes (project_id, suggestion_id, user_id, vote)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, suggestion_id, user_id)
     DO UPDATE SET vote=EXCLUDED.vote, updated_at=now()`,
    [project_id, suggestion_id, user_id, vote]
  );
}

async function refreshSuggestionCounters(project_id, suggestion_id) {
  const agg = await pool.query(
    `SELECT
       SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)::int AS up,
       SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)::int AS down
     FROM suggestion_votes
     WHERE project_id=$1 AND suggestion_id=$2`,
    [project_id, suggestion_id]
  );

  const up = agg.rows[0]?.up ?? 0;
  const down = agg.rows[0]?.down ?? 0;

  await pool.query(
    `UPDATE suggestions
     SET upvotes_count=$1, downvotes_count=$2, score=$3, updated_at=now()
     WHERE project_id=$4 AND id=$5`,
    [up, down, up - down, project_id, suggestion_id]
  );
}

async function pullToBacklog({ project_id, suggestion_id, created_by_user_id }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sugRes = await client.query(
      `SELECT id, title, description, backlog_item_id
       FROM suggestions
       WHERE project_id=$1 AND id=$2
       FOR UPDATE`,
      [project_id, suggestion_id]
    );
    const sug = sugRes.rows[0];
    if (!sug) throw new Error("Sugestão não encontrada");
    if (sug.backlog_item_id) {
      await client.query("ROLLBACK");
      return sug.backlog_item_id;
    }

    const backlog_id = uuid();

    await client.query(
      `INSERT INTO backlog_items
        (id, project_id, origin_type, suggestion_id, title, summary, stage, priority, progress_percent, created_by_user_id)
       VALUES ($1, $2, 'suggestion', $3, $4, $5, 'doing', 'high', 0, $6)`,
      [backlog_id, project_id, suggestion_id, sug.title, sug.description, created_by_user_id]
    );

    await client.query(
      `UPDATE suggestions
       SET status='in_progress', backlog_item_id=$1, locked_at=now(), progress_percent=0, updated_at=now()
       WHERE project_id=$2 AND id=$3`,
      [backlog_id, project_id, suggestion_id]
    );

    await client.query("COMMIT");
    return backlog_id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function createTask({ project_id, backlog_item_id, stack, title, description, created_by_user_id, order_index }) {
  const stackIdRes = await pool.query(`SELECT id FROM developer_stacks WHERE code=$1`, [stack]);
  const stack_id = stackIdRes.rows[0]?.id;
  if (!stack_id) throw new Error(`Stack inválida: ${stack}`);

  const id = uuid();

  await pool.query(
    `INSERT INTO backlog_tasks
      (id, project_id, backlog_item_id, stack_id, title, description, is_done, order_index, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8)`,
    [id, project_id, backlog_item_id, stack_id, title, description, order_index ?? 0, created_by_user_id]
  );

  return id;
}

async function recalcProgress(project_id, backlog_item_id) {
  const tasksRes = await pool.query(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN is_done THEN 1 ELSE 0 END)::int AS done
     FROM backlog_tasks
     WHERE project_id=$1 AND backlog_item_id=$2`,
    [project_id, backlog_item_id]
  );
  const total = tasksRes.rows[0]?.total ?? 0;
  const done = tasksRes.rows[0]?.done ?? 0;
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);

  await pool.query(
    `UPDATE backlog_items SET progress_percent=$1, updated_at=now()
     WHERE project_id=$2 AND id=$3`,
    [progress, project_id, backlog_item_id]
  );

  const link = await pool.query(
    `SELECT suggestion_id FROM backlog_items WHERE project_id=$1 AND id=$2`,
    [project_id, backlog_item_id]
  );
  const suggestion_id = link.rows[0]?.suggestion_id;
  if (suggestion_id) {
    await pool.query(
      `UPDATE suggestions SET progress_percent=$1, updated_at=now()
       WHERE project_id=$2 AND id=$3`,
      [progress, project_id, suggestion_id]
    );
  }
}

async function main() {
  const adminId = uuid();
	const devId = uuid();
	const managerId = uuid();
	const userId = uuid();

	const proj1 = uuid();
	const proj2 = uuid();


  console.log("Seeding...");

  // Users
  await upsertUser({
    id: userId,
    name: "João Silva",
    email: "joao@email.com",
    role: "user",
    password: "123456",
    stacks: [],
  });

  await upsertUser({
    id: managerId,
    name: "Maria Santos",
    email: "maria@email.com",
    role: "manager",
    password: "123456",
    stacks: [],
  });

  await upsertUser({
    id: devId,
    name: "Pedro Costa",
    email: "pedro@email.com",
    role: "developer",
    password: "123456",
    stacks: ["frontend", "backend"],
  });

  await upsertUser({
    id: adminId,
    name: "Ana Oliveira",
    email: "ana@email.com",
    role: "admin",
    password: "123456",
    stacks: ["frontend", "backend", "infra"],
  });

  // Projects
  await upsertProject({
    id: proj1,
    name: "Sistema de Vendas",
    description: "Plataforma de e-commerce com carrinho e checkout",
    created_by_user_id: adminId,
  });

  await upsertProject({
    id: proj2,
    name: "App de Delivery",
    description: "Aplicativo para pedidos e entregas de comida",
    created_by_user_id: adminId,
  });

  // Memberships
  // Project 1: todos
  await addMember(proj1, userId);
  await addMember(proj1, managerId);
  await addMember(proj1, devId);
  await addMember(proj1, adminId);

  // Project 2: manager/dev/admin
  await addMember(proj2, managerId);
  await addMember(proj2, devId);
  await addMember(proj2, adminId);

  // Suggestions
  const sug1 = uuid();
const sug2 = uuid();
const sug3 = uuid();
const sug4 = uuid();
const sug5 = uuid();


  await createSuggestion({
    id: sug1,
    project_id: proj1,
    created_by_user_id: userId,
    title: "Adicionar filtro por categoria",
    description: "Permitir que usuários filtrem produtos por categoria na página principal",
    status: "open"
  });

  await createSuggestion({
    id: sug2,
    project_id: proj1,
    created_by_user_id: managerId,
    title: "Melhorar página de checkout",
    description: "Simplificar o processo de checkout para aumentar conversão",
    status: "open"
  });

  await createSuggestion({
    id: sug3,
    project_id: proj1,
    created_by_user_id: devId,
    title: "Integrar com gateway de pagamento",
    description: "Adicionar suporte a PIX e cartão de crédito via Stripe",
    status: "open"
  });

  await createSuggestion({
    id: sug4,
    project_id: proj2,
    created_by_user_id: managerId,
    title: "Rastreamento em tempo real",
    description: "Mostrar localização do entregador no mapa",
    status: "open"
  });

  await createSuggestion({
    id: sug5,
    project_id: proj2,
    created_by_user_id: devId,
    title: "Notificações push",
    description: "Enviar notificações quando pedido mudar de status",
    status: "open"
  });

  // Votes
  await upsertVote({ project_id: proj1, suggestion_id: sug1, user_id: userId, vote: 1 });
  await upsertVote({ project_id: proj1, suggestion_id: sug1, user_id: managerId, vote: 1 });
  await upsertVote({ project_id: proj1, suggestion_id: sug2, user_id: userId, vote: 1 });
  await upsertVote({ project_id: proj1, suggestion_id: sug2, user_id: devId, vote: 1 });

  // Refresh counters
  await refreshSuggestionCounters(proj1, sug1);
  await refreshSuggestionCounters(proj1, sug2);
  await refreshSuggestionCounters(proj1, sug3);
  await refreshSuggestionCounters(proj2, sug4);
  await refreshSuggestionCounters(proj2, sug5);

  // Pull one suggestion to backlog and add tasks
  const backlogId1 = await pullToBacklog({ project_id: proj1, suggestion_id: sug1, created_by_user_id: devId });

  // tasks for backlogId1
  await createTask({
    project_id: proj1,
    backlog_item_id: backlogId1,
    stack: "frontend",
    title: "Criar componente de filtro",
    description: "Desenvolver UI do filtro com dropdown de categorias",
    created_by_user_id: devId,
    order_index: 1
  });

  await createTask({
    project_id: proj1,
    backlog_item_id: backlogId1,
    stack: "backend",
    title: "API de categorias",
    description: "Endpoint para listar categorias disponíveis",
    created_by_user_id: devId,
    order_index: 2
  });

  await createTask({
    project_id: proj1,
    backlog_item_id: backlogId1,
    stack: "frontend",
    title: "Integrar filtro com listagem",
    description: "Conectar filtro à listagem de produtos",
    created_by_user_id: devId,
    order_index: 3
  });

  // marca 2 como done pra dar progresso (66%)
  await pool.query(
    `UPDATE backlog_tasks
     SET is_done = true, done_at=now(), updated_at=now()
     WHERE project_id=$1 AND backlog_item_id=$2 AND title IN ('Criar componente de filtro','API de categorias')`,
    [proj1, backlogId1]
  );

  await recalcProgress(proj1, backlogId1);

  console.log("Seed finalizado ✅");
  console.log("Usuários criados (senha 123456):");
  console.log("- joao@email.com (user)");
  console.log("- maria@email.com (manager)");
  console.log("- pedro@email.com (developer)");
  console.log("- ana@email.com (admin)");
}

main()
  .catch((e) => {
    console.error("Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
