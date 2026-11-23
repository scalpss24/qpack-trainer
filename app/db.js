/**
 * IndexedDB storage layer matching qpack.md Section 4:
 * - packages: { package_id, title, created_at, imported_at, categories, questions }
 * - images: { key: `${package_id}/${rel_path}`, blob: Blob }
 * - user_progress: { question_id, status, attempts_count, correct_count, is_favorite, user_note, last_answered_at }
 */

const DB_NAME = "qpack_trainer_db";
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("packages")) {
        db.createObjectStore("packages", { keyPath: "package_id" });
      }
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("user_progress")) {
        db.createObjectStore("user_progress", { keyPath: "question_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePackage(manifest, imageEntries) {
  const db = await openDB();
  const tx = db.transaction(["packages", "images"], "readwrite");
  const pkgStore = tx.objectStore("packages");
  const imgStore = tx.objectStore("images");

  pkgStore.put({
    package_id: manifest.package_id,
    title: manifest.title,
    format_version: manifest.format_version || "1.0",
    created_at: manifest.created_at,
    imported_at: new Date().toISOString(),
    categories: manifest.categories || [],
    questions: manifest.questions || [],
  });

  for (const [relPath, blob] of imageEntries) {
    imgStore.put({
      key: `${manifest.package_id}/${relPath}`,
      blob,
    });
  }

  await txPromise(tx);
}

export async function getAllPackages() {
  const db = await openDB();
  const tx = db.transaction("packages", "readonly");
  return reqPromise(tx.objectStore("packages").getAll());
}

export async function getPackage(packageId) {
  const db = await openDB();
  const tx = db.transaction("packages", "readonly");
  return reqPromise(tx.objectStore("packages").get(packageId));
}

export async function deletePackage(packageId) {
  const db = await openDB();
  const pkg = await getPackage(packageId);
  const tx = db.transaction(["packages", "images"], "readwrite");
  tx.objectStore("packages").delete(packageId);
  if (pkg && pkg.questions) {
    const imgStore = tx.objectStore("images");
    for (const q of pkg.questions) {
      for (const relPath of q.images || []) {
        imgStore.delete(`${packageId}/${relPath}`);
      }
    }
  }
  await txPromise(tx);
}

export async function getImageBlob(packageId, relPath) {
  const db = await openDB();
  const tx = db.transaction("images", "readonly");
  const rec = await reqPromise(tx.objectStore("images").get(`${packageId}/${relPath}`));
  return rec ? rec.blob : null;
}

export async function getAllProgressMap() {
  const db = await openDB();
  const tx = db.transaction("user_progress", "readonly");
  const rows = await reqPromise(tx.objectStore("user_progress").getAll());
  const map = new Map();
  for (const r of rows) {
    map.set(r.question_id, r);
  }
  return map;
}

export function defaultProgress(questionId) {
  return {
    question_id: questionId,
    status: "unseen",
    attempts_count: 0,
    correct_count: 0,
    is_favorite: false,
    user_note: "",
    last_answered_at: null,
  };
}

export async function saveProgressRecord(record) {
  const db = await openDB();
  const tx = db.transaction("user_progress", "readwrite");
  tx.objectStore("user_progress").put(record);
  await txPromise(tx);
}

export async function exportProgressBackup() {
  const map = await getAllProgressMap();
  return {
    backup_version: "1.0",
    exported_at: new Date().toISOString(),
    records: Array.from(map.values()),
  };
}

export async function importProgressBackup(data) {
  if (!data || !Array.isArray(data.records)) {
    throw new Error("Неверный формат файла резервной копии");
  }
  const db = await openDB();
  const tx = db.transaction("user_progress", "readwrite");
  const store = tx.objectStore("user_progress");
  let count = 0;
  for (const rec of data.records) {
    if (rec && rec.question_id) {
      store.put({
        ...defaultProgress(rec.question_id),
        ...rec,
      });
      count++;
    }
  }
  await txPromise(tx);
  return count;
}
