/**
 * Saved programs, kept in the browser's localStorage.
 *
 * Each program belongs to one language. Everything is stored under a single
 * key as a JSON array, which is plenty for hand-written programs (browsers
 * allow about 5 MB per site).
 */
import { isLanguageId, type LanguageId } from "./languages";

export interface Program {
  id: string;
  name: string;
  language: LanguageId;
  code: string;
  createdAt: number;
  updatedAt: number;
}

/** The part of the Storage API we use, so tests can pass a fake. */
export type ProgramStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "algoviz:programs";

export class StorageFullError extends Error {
  constructor() {
    super("Couldn't save: the browser's storage for this site is full or unavailable.");
  }
}

function isProgram(value: unknown): value is Program {
  const p = value as Program;
  return !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.code === "string" &&
    isLanguageId(p.language) && typeof p.updatedAt === "number";
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class ProgramStore {
  /** Used when localStorage is unavailable: programs last for this session only. */
  private memory: Program[] = [];

  constructor(private readonly storage: ProgramStorage | null, private readonly now = () => Date.now()) {}

  /** Programs for one language, most recently saved first. */
  list(language: LanguageId): Program[] {
    return this.read()
      .filter((p) => p.language === language)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string | null): Program | undefined {
    return id ? this.read().find((p) => p.id === id) : undefined;
  }

  findByName(language: LanguageId, name: string): Program | undefined {
    return this.read().find((p) => p.language === language && sameName(p.name, name));
  }

  /** Create a program, or update it when `id` matches an existing one. */
  save(input: { id?: string; name: string; language: LanguageId; code: string }): Program {
    const programs = this.read();
    const name = input.name.trim();
    const time = this.now();
    const existing = input.id ? programs.find((p) => p.id === input.id) : undefined;
    const program: Program = existing
      ? { ...existing, name, code: input.code, updatedAt: time }
      : { id: newId(), name, language: input.language, code: input.code, createdAt: time, updatedAt: time };
    this.write(existing ? programs.map((p) => (p.id === program.id ? program : p)) : [...programs, program]);
    return program;
  }

  remove(id: string): void {
    this.write(this.read().filter((p) => p.id !== id));
  }

  private read(): Program[] {
    if (!this.storage) return this.memory;
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isProgram) : [];
    } catch {
      return []; // unreadable data shouldn't break the app
    }
  }

  private write(programs: Program[]): void {
    if (!this.storage) {
      this.memory = programs;
      return;
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(programs));
    } catch {
      throw new StorageFullError();
    }
  }
}
