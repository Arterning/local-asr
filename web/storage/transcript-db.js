const DB_NAME = "live-subtitle-transcripts";
const DB_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sessions = db.createObjectStore("sessions", { keyPath: "id" });
      sessions.createIndex("createdAt", "createdAt");
      sessions.createIndex("status", "status");

      const segments = db.createObjectStore("segments", {
        keyPath: "id",
        autoIncrement: true,
      });
      segments.createIndex("sessionId", "sessionId");
      segments.createIndex("sessionSequence", ["sessionId", "sequence"], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createSession(metadata) {
  const db = await openDatabase();
  const transaction = db.transaction("sessions", "readwrite");
  const session = {
    id: crypto.randomUUID(),
    title: metadata.title || "未命名视频",
    url: metadata.url || "",
    platform: metadata.platform || "unknown",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    status: "recording",
    segmentCount: 0,
    lastVideoTime: null,
  };
  transaction.objectStore("sessions").add(session);
  await transactionDone(transaction);
  db.close();
  return session;
}

export async function getSession(id) {
  const db = await openDatabase();
  const transaction = db.transaction("sessions", "readonly");
  const result = await requestResult(transaction.objectStore("sessions").get(id));
  await transactionDone(transaction);
  db.close();
  return result;
}

export async function updateSession(id, changes) {
  const db = await openDatabase();
  const transaction = db.transaction("sessions", "readwrite");
  const store = transaction.objectStore("sessions");
  const session = await requestResult(store.get(id));
  if (session) store.put({ ...session, ...changes, updatedAt: Date.now() });
  await transactionDone(transaction);
  db.close();
}

export async function appendSegment(sessionId, segment) {
  const db = await openDatabase();
  const transaction = db.transaction(["sessions", "segments"], "readwrite");
  const sessions = transaction.objectStore("sessions");
  const session = await requestResult(sessions.get(sessionId));
  if (!session) {
    transaction.abort();
    db.close();
    throw new Error("Transcript session not found");
  }

  const sequence = session.segmentCount + 1;
  transaction.objectStore("segments").add({
    sessionId,
    sequence,
    text: segment.text,
    startTime: segment.startTime,
    endTime: segment.endTime,
    createdAt: Date.now(),
  });
  sessions.put({
    ...session,
    segmentCount: sequence,
    lastVideoTime: segment.endTime,
    updatedAt: Date.now(),
  });
  await transactionDone(transaction);
  db.close();
  return sequence;
}

export async function listSessions() {
  const db = await openDatabase();
  const transaction = db.transaction("sessions", "readonly");
  const sessions = await requestResult(transaction.objectStore("sessions").getAll());
  await transactionDone(transaction);
  db.close();
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSegments(sessionId) {
  const db = await openDatabase();
  const transaction = db.transaction("segments", "readonly");
  const segments = await requestResult(
    transaction.objectStore("segments").index("sessionId").getAll(sessionId),
  );
  await transactionDone(transaction);
  db.close();
  return segments.sort((a, b) => a.sequence - b.sequence);
}

export async function deleteSession(id) {
  const db = await openDatabase();
  const transaction = db.transaction(["sessions", "segments"], "readwrite");
  transaction.objectStore("sessions").delete(id);
  const index = transaction.objectStore("segments").index("sessionId");
  const cursorRequest = index.openKeyCursor(IDBKeyRange.only(id));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    transaction.objectStore("segments").delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(transaction);
  db.close();
}

export async function clearHistory() {
  const db = await openDatabase();
  const transaction = db.transaction(["sessions", "segments"], "readwrite");
  transaction.objectStore("sessions").clear();
  transaction.objectStore("segments").clear();
  await transactionDone(transaction);
  db.close();
}
