export type Role = "user" | "manager" | "developer" | "admin";
export type StackCode = "frontend" | "backend" | "infra";

export type JwtPayload = {
  sub: string; // user id
  role: Role;
};
