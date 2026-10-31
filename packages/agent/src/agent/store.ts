import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../types.js";

export type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface StepRecord {
  n: number;
  tool: string;
  summary: string;
  ok: boolean;
  verified: boolean;
  denied?: boolean;
  output: string;
}

export interface TaskRecord {
  id: string;
  goal: string;
  status: TaskStatus;
  messages: ChatMessage[];
  steps: StepRecord[];
  answer: string;
  createdAt: string;
  updatedAt: string;
}

/** Persistent task state (SQLite). A checkpoint is written after every step. */
export class TaskStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
      messages TEXT NOT NULL, steps TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  save(t: TaskRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks(id,goal,status,messages,steps,answer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,messages=excluded.messages,steps=excluded.steps,answer=excluded.answer,updated_at=excluded.updated_at`,
      )
      .run(t.id, t.goal, t.status, JSON.stringify(t.messages), JSON.stringify(t.steps), t.answer, t.createdAt, now);
  }

  get(id: string): TaskRecord | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, string> | undefined;
    return r && this.row(r);
  }

  list(limit = 20): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, string>[];
    return rows.map((r) => this.row(r));
  }

  /** Tasks left in 'running' state by a crash; they are marked 'interrupted' so they can be resumed. */
  recoverInterrupted(): TaskRecord[] {
    this.db.prepare("UPDATE tasks SET status='interrupted' WHERE status='running'").run();
    return this.list(100).filter((t) => t.status === "interrupted");
  }

  private row(r: Record<string, string>): TaskRecord {
    return {
      id: r["id"]!, goal: r["goal"]!, status: r["status"] as TaskStatus,
      messages: JSON.parse(r["messages"]!) as ChatMessage[], steps: JSON.parse(r["steps"]!) as StepRecord[],
      answer: r["answer"] ?? "", createdAt: r["created_at"]!, updatedAt: r["updated_at"]!,
    };
  }

  close(): void { this.db.close(); }
}
