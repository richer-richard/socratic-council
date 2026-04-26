import type { AttachmentKind } from "./attachments";
import {
  aliasAttachmentRecordToProject,
  deleteProjectAttachmentBlobs,
} from "./attachments";
import type { SessionSummary } from "./sessions";
import { listSessionSummaries } from "./sessions";
import { decryptString, encryptString, isEnvelopedCiphertext } from "./vault";

const PROJECT_INDEX_KEY = "socratic-council-project-index-v1";
const PROJECT_KEY_PREFIX = "socratic-council-project:";

export class ProjectPersistenceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProjectPersistenceError";
    this.cause = cause;
  }
}

export interface ProjectDossierEntry {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  addedAt: number;
  sourceSessionId: string | null;
  note: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  dossier: ProjectDossierEntry[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  sessionCount: number;
  dossierCount: number;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

function readSecureItem(storage: Storage, key: string): string | null {
  const raw = storage.getItem(key);
  if (raw == null) return null;
  if (!isEnvelopedCiphertext(raw)) return raw;
  try {
    return decryptString(raw);
  } catch (error) {
    console.error(`[projects] Failed to decrypt storage key "${key}":`, error);
    return null;
  }
}

function writeSecureItem(storage: Storage, key: string, value: string): void {
  storage.setItem(key, encryptString(value));
}

function createProjectStorageKey(id: string): string {
  return `${PROJECT_KEY_PREFIX}${id}`;
}

function createProjectId(): string {
  return `project_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return value === "image" || value === "pdf" || value === "text" || value === "binary";
}

function normalizeDossierEntry(input: unknown): ProjectDossierEntry | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<ProjectDossierEntry>;
  const attachmentId = cleanText(record.attachmentId).trim();
  const name = cleanText(record.name).trim();
  if (!attachmentId || !name) return null;

  return {
    attachmentId,
    name,
    mimeType: cleanText(record.mimeType, "application/octet-stream"),
    size: clampNumber(record.size),
    kind: isAttachmentKind(record.kind) ? record.kind : "binary",
    addedAt: clampNumber(record.addedAt, Date.now()),
    sourceSessionId: typeof record.sourceSessionId === "string" ? record.sourceSessionId : null,
    note: cleanText(record.note),
  };
}

function normalizeProject(input: unknown): Project | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<Project>;
  const id = cleanText(record.id).trim();
  const name = cleanText(record.name).trim();

  if (!id || !name) return null;

  const createdAt = clampNumber(record.createdAt, Date.now());
  const updatedAt = clampNumber(record.updatedAt, createdAt);
  const lastOpenedAt = clampNumber(record.lastOpenedAt, updatedAt);

  const dossier = Array.isArray(record.dossier)
    ? record.dossier
        .map((entry) => normalizeDossierEntry(entry))
        .filter((entry): entry is ProjectDossierEntry => Boolean(entry))
    : [];

  return {
    id,
    name: name.slice(0, 120),
    description: cleanText(record.description),
    createdAt,
    updatedAt,
    lastOpenedAt,
    archivedAt: record.archivedAt == null ? null : clampNumber(record.archivedAt),
    dossier,
  };
}

function countProjectSessions(projectId: string): number {
  return listSessionSummaries().filter((s) => s.projectId === projectId).length;
}

function buildProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
    archivedAt: project.archivedAt,
    sessionCount: countProjectSessions(project.id),
    dossierCount: project.dossier.length,
  };
}

/** Bumped when readProjectIndex catches a parse / decrypt failure so the
 * UI can surface "your project list might be incomplete" instead of
 * silently rendering an empty home page (fix 2.16). */
let projectIndexFailureCount = 0;

export function getProjectIndexFailureCount(): number {
  return projectIndexFailureCount;
}

export function __resetProjectIndexFailureCountForTests(): void {
  projectIndexFailureCount = 0;
}

function readProjectIndex(): ProjectSummary[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = readSecureItem(storage, PROJECT_INDEX_KEY);
    if (raw == null) {
      // Distinguish "no index" (fresh install) from "decrypt failed".
      const onDisk = storage.getItem(PROJECT_INDEX_KEY);
      if (onDisk != null) projectIndexFailureCount += 1;
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      projectIndexFailureCount += 1;
      return [];
    }

    return parsed
      .filter((entry): entry is ProjectSummary => !!entry && typeof entry === "object")
      .map((entry) => ({
        id: cleanText(entry.id),
        name: cleanText(entry.name),
        description: cleanText(entry.description),
        createdAt: clampNumber(entry.createdAt),
        updatedAt: clampNumber(entry.updatedAt),
        lastOpenedAt: clampNumber(entry.lastOpenedAt),
        archivedAt: entry.archivedAt == null ? null : clampNumber(entry.archivedAt),
        sessionCount: clampNumber(entry.sessionCount),
        dossierCount: clampNumber(entry.dossierCount),
      }))
      .filter((entry) => entry.id.length > 0);
  } catch (error) {
    projectIndexFailureCount += 1;
    console.error("Failed to read project index:", error);
    return [];
  }
}

function writeProjectIndex(index: ProjectSummary[]): void {
  const storage = getStorage();
  if (!storage) return;
  writeSecureItem(storage, PROJECT_INDEX_KEY, JSON.stringify(index));
}

function replaceProjectIndexEntry(
  index: ProjectSummary[],
  summary: ProjectSummary,
): ProjectSummary[] {
  const next = index.filter((entry) => entry.id !== summary.id);
  next.unshift(summary);
  return next.sort(
    (a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt),
  );
}

export function listProjectSummaries(): ProjectSummary[] {
  return readProjectIndex().sort(
    (a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt),
  );
}

export function saveProject(project: Project): Project {
  const storage = getStorage();
  if (!storage) {
    return project;
  }

  const normalized = normalizeProject(project);
  if (!normalized) {
    throw new Error("Invalid project payload");
  }

  try {
    writeSecureItem(
      storage,
      createProjectStorageKey(normalized.id),
      JSON.stringify(normalized),
    );
    writeProjectIndex(
      replaceProjectIndexEntry(readProjectIndex(), buildProjectSummary(normalized)),
    );
  } catch (error) {
    console.error("Failed to save project:", error);
    throw new ProjectPersistenceError(
      "Failed to save the project locally. Free up browser storage space and try again.",
      error,
    );
  }

  return normalized;
}

export function loadProject(id: string): Project | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = readSecureItem(storage, createProjectStorageKey(id));
    if (!raw) return null;

    return normalizeProject(JSON.parse(raw));
  } catch (error) {
    console.error("Failed to load project:", error);
    return null;
  }
}

export function deleteProject(id: string): boolean {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.removeItem(createProjectStorageKey(id));
    writeProjectIndex(readProjectIndex().filter((entry) => entry.id !== id));
    // Fix 2.15 wiring: clean up the project's IndexedDB attachment ownership
    // (best-effort — failures here don't block the metadata delete because
    // the dossier-aliased records would otherwise become orphans). When a
    // record's owner list goes empty after this removal it's deleted; when
    // a session still references it, only the project's claim is dropped.
    void deleteProjectAttachmentBlobs(id).catch((error) => {
      console.warn(
        `[projects] deleteProjectAttachmentBlobs(${id}) failed; project deleted anyway.`,
        error,
      );
    });
    return true;
  } catch (error) {
    console.error("Failed to delete project:", error);
    return false;
  }
}

function updateProjectArchivedState(id: string, archivedAt: number | null): Project | null {
  const existing = loadProject(id);
  if (!existing) return null;

  try {
    return saveProject({
      ...existing,
      archivedAt,
      ...(archivedAt == null ? { lastOpenedAt: Date.now() } : {}),
    });
  } catch (error) {
    console.error("Failed to update project archived state:", error);
    return null;
  }
}

export function archiveProject(id: string): Project | null {
  return updateProjectArchivedState(id, Date.now());
}

export function restoreProject(id: string): Project | null {
  return updateProjectArchivedState(id, null);
}

export function touchProject(id: string): Project | null {
  const existing = loadProject(id);
  if (!existing) return null;

  try {
    return saveProject({
      ...existing,
      archivedAt: null,
      lastOpenedAt: Date.now(),
    });
  } catch (error) {
    console.error("Failed to touch project:", error);
    return null;
  }
}

export function createProject(name: string, description = ""): Project {
  const trimmedName = name.trim().slice(0, 120);
  const now = Date.now();

  const project: Project = {
    id: createProjectId(),
    name: trimmedName,
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    archivedAt: null,
    dossier: [],
  };

  return saveProject(project);
}

export function getProjectSessionSummaries(projectId: string): SessionSummary[] {
  return listSessionSummaries().filter((s) => s.projectId === projectId);
}

export function addDossierEntry(
  projectId: string,
  entry: Omit<ProjectDossierEntry, "addedAt">,
): Project | null {
  const project = loadProject(projectId);
  if (!project) return null;

  const fullEntry: ProjectDossierEntry = {
    ...entry,
    addedAt: Date.now(),
  };

  // Fix 2.10: also add the project to the IndexedDB record's owner list
  // so the blob survives deletion of the source session. Best-effort —
  // failure here doesn't block the metadata save (the dossier remains a
  // pointer; if the alias didn't take, the user gets a dangling reference
  // which is the pre-fix behavior, not a regression).
  void aliasAttachmentRecordToProject(entry.attachmentId, projectId).catch((error) => {
    console.warn(
      `[projects] Failed to alias attachment ${entry.attachmentId} to project ${projectId}; the dossier entry may break if the source session is deleted.`,
      error,
    );
  });

  return saveProject({
    ...project,
    updatedAt: Date.now(),
    dossier: [...project.dossier, fullEntry],
  });
}

export function removeDossierEntry(projectId: string, attachmentId: string): Project | null {
  const project = loadProject(projectId);
  if (!project) return null;

  return saveProject({
    ...project,
    updatedAt: Date.now(),
    dossier: project.dossier.filter((e) => e.attachmentId !== attachmentId),
  });
}

export function refreshProjectSummary(projectId: string): void {
  const project = loadProject(projectId);
  if (!project) return;

  writeProjectIndex(replaceProjectIndexEntry(readProjectIndex(), buildProjectSummary(project)));
}
