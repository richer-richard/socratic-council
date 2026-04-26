import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addDossierEntry,
  archiveProject,
  createProject,
  deleteProject,
  listProjectSummaries,
  loadProject,
  removeDossierEntry,
  restoreProject,
  saveProject,
  type Project,
} from "./projects";

vi.mock("./attachments", () => ({
  aliasAttachmentRecordToProject: () => Promise.resolve(),
  deleteProjectAttachmentBlobs: () => Promise.resolve(),
}));

vi.mock("./sessions", () => ({
  listSessionSummaries: () => [],
}));

function installInMemoryStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
    },
  });
}

describe("project CRUD round-trip", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installInMemoryStorage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("creates and lists a project", () => {
    const created = createProject("Quantum stuff", "research notes");
    expect(created.name).toBe("Quantum stuff");
    expect(created.dossier).toEqual([]);

    const summaries = listProjectSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(created.id);

    const loaded = loadProject(created.id);
    expect(loaded?.description).toBe("research notes");
  });

  it("archives + restores a project, preserving its data", () => {
    const created = createProject("My project");
    const archived = archiveProject(created.id);
    expect(archived?.archivedAt).not.toBeNull();

    const restored = restoreProject(created.id);
    expect(restored?.archivedAt).toBeNull();
    expect(restored?.id).toBe(created.id);
  });

  it("adds and removes dossier entries", () => {
    const created = createProject("Dossier test");
    const updated = addDossierEntry(created.id, {
      attachmentId: "att_1",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1024,
      kind: "pdf",
      sourceSessionId: "session_1",
      note: "Original report",
    });
    expect(updated?.dossier).toHaveLength(1);
    expect(updated?.dossier[0]?.attachmentId).toBe("att_1");

    const afterRemove = removeDossierEntry(created.id, "att_1");
    expect(afterRemove?.dossier).toEqual([]);
  });

  it("deletes a project and removes it from the index", () => {
    const created = createProject("To be deleted");
    expect(deleteProject(created.id)).toBe(true);
    expect(loadProject(created.id)).toBeNull();
    expect(listProjectSummaries()).toEqual([]);
  });

  it("does not crash when saving a project with empty optional fields", () => {
    const project: Project = {
      id: "minimal",
      name: "minimal",
      description: "",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      archivedAt: null,
      dossier: [],
    };
    const saved = saveProject(project);
    expect(saved.id).toBe("minimal");
    expect(loadProject("minimal")?.name).toBe("minimal");
  });
});
