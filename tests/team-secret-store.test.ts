import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTeamDesktop, electronSecretStore } from "../src/desktop/team.js";

test("an unconfigured team store never initializes OS encryption during app startup or status reads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-secret-lazy-"));
  let probes = 0;
  let plain = "";
  const safe = {
    isEncryptionAvailable() {
      throw new Error("Synchronous OS crypto must not be called");
    },
    async isAsyncEncryptionAvailable() {
      probes++;
      return true;
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    async encryptStringAsync(value: string) {
      plain = value;
      return Buffer.from("encrypted fixture");
    },
    async decryptStringAsync() {
      return { result: plain, shouldReEncrypt: false };
    },
  } as unknown as Electron.SafeStorage;
  try {
    const secrets = electronSecretStore(
      safe,
      path.join(dir, "team.bin"),
      false,
    );
    assert.equal(secrets.status().backend, "unchecked");
    assert.equal(await secrets.read(), null);
    assert.equal(probes, 0);
    const team = createTeamDesktop({
      store: async () => ({ link: null, projects: [], outbox: [] }),
      secrets,
      openUrl: () => {},
      emit: () => {},
    });
    const status: any = await team.handle("status", {});
    assert.equal(status.connected, false);
    assert.equal(probes, 0);
    const prepared: any = await team.handle("prepare", {});
    assert.equal(prepared.secretStorage.available, true);
    assert.equal(probes, 1);
    const value: any = {
      serviceUrl: "https://fixture.invalid",
      tokens: { sessionToken: "fixture-only" },
    };
    await secrets.write(value);
    assert.equal(
      fs.readFileSync(path.join(dir, "team.bin"), "utf8"),
      "encrypted fixture",
    );
    assert.deepEqual(await secrets.read(), value);
    await secrets.write(null);
    assert.equal(fs.existsSync(path.join(dir, "team.bin")), false);
    team.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pending credential restoration does not block local status, and disposal prevents a late restore", async () => {
  let release!: (v: null) => void;
  const pending = new Promise<null>((resolve) => {
    release = resolve;
  });
  const team = createTeamDesktop({
    store: async () => ({ link: null, projects: [], outbox: [] }),
    secrets: {
      status: () => ({
        available: false,
        backend: "checking",
        detail: "Waiting for storage",
      }),
      read: () => pending,
      write: () => {},
    },
    openUrl: () => {},
    emit: () => {},
  });
  const status: any = await team.handle("status", {});
  assert.equal(status.secretStorage.backend, "checking");
  assert.equal(status.connected, false);
  const pendingConnect = team.handle("connect", { serviceUrl: "https://fixture.invalid" });
  team.dispose();
  release(null);
  await assert.rejects(pendingConnect, /closed/);
  await assert.rejects(
    team.handle("connect", { serviceUrl: "https://fixture.invalid" }),
    /closed/,
  );
});

test("logout is ordered after an in-flight encrypted credential write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-secret-order-"));
  let unlock!: (value: Buffer) => void;
  const safe = {
    async isAsyncEncryptionAvailable() {
      return true;
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    encryptStringAsync() {
      return new Promise<Buffer>((resolve) => {
        unlock = resolve;
      });
    },
  } as unknown as Electron.SafeStorage;
  try {
    const file = path.join(dir, "team.bin");
    const secrets = electronSecretStore(safe, file, false);
    await secrets.prepare!();
    const save = secrets.write({
      serviceUrl: "https://fixture.invalid",
      tokens: {} as any,
    });
    while (!unlock) await new Promise((resolve) => setImmediate(resolve));
    const logout = secrets.write(null);
    unlock(Buffer.from("encrypted"));
    await Promise.all([save, logout]);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
