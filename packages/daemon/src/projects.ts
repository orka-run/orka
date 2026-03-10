import { join } from "node:path";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getOrkaHome } from "./db";

export interface ProjectEntry {
  name: string;
  path: string;
}

const PROJECTS_FILE = "projects.json";

function getProjectsPath(): string {
  return join(getOrkaHome(), PROJECTS_FILE);
}

function loadProjects(): ProjectEntry[] {
  const p = getProjectsPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveProjects(projects: ProjectEntry[]): void {
  writeFileSync(getProjectsPath(), JSON.stringify(projects, null, 2) + "\n");
}

/** Register a project alias. */
export function addProject(name: string, path: string): ProjectEntry {
  const absPath = resolve(path);
  const projects = loadProjects();
  const existing = projects.find((p) => p.name === name);
  if (existing) {
    existing.path = absPath;
  } else {
    projects.push({ name, path: absPath });
  }
  saveProjects(projects);
  return { name, path: absPath };
}

/** Remove a project by name. Returns true if found. */
export function removeProject(name: string): boolean {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.name === name);
  if (idx === -1) return false;
  projects.splice(idx, 1);
  saveProjects(projects);
  return true;
}

/** List all registered projects. */
export function listProjects(): ProjectEntry[] {
  return loadProjects();
}

/** Resolve a project reference to an absolute path.
 *  Checks: registered alias → absolute path → relative path from cwd.
 */
export function resolveProject(ref: string): string {
  // Check registered aliases first
  const projects = loadProjects();
  const byName = projects.find((p) => p.name === ref);
  if (byName) return byName.path;

  // Otherwise treat as path
  return resolve(ref);
}

/** Find a registered project name for a given path. Returns null if not registered. */
export function projectNameForPath(absPath: string): string | null {
  const projects = loadProjects();
  const entry = projects.find((p) => p.path === absPath);
  return entry?.name ?? null;
}
