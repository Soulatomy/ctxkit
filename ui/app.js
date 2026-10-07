import { t, applyStatic, getLang, getLangs, langLabel, setLang } from "./i18n.js";

const TOKEN_KEY = "fb_token";
let token = localStorage.getItem(TOKEN_KEY) || "";

const api = async (method, path, body) => {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const splitTags = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 5000);
}

const state = { engines: [], profiles: [], proxies: [], users: [], settings: null, search: "", folder: "", selected: new Set(), obStep: 1 };

/* ---------------------------------------------------------------- loaders --- */
function fillSelects() {
  const engineOpts = state.engines.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}</option>`).join("");
  const proxyOpts =
    `<option value="">${esc(t("opt.direct"))}</option>` +
    state.proxies.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.server)}</option>`).join("");
  for (const sel of $$('select[name="engine"]')) { const c = sel.value; sel.innerHTML = engineOpts; if (c) sel.value = c; }
  for (const sel of $$('select[name="proxyId"]')) { const c = sel.value; sel.innerHTML = proxyOpts; if (c) sel.value = c; }
  const defProxy = document.querySelector('#settings-form select[name="defaultProxyId"]');
  if (defProxy) { const c = defProxy.value; defProxy.innerHTML = proxyOpts; if (c) defProxy.value = c; }
}

async function loadEngines() {
  state.engines = await api("GET", "/api/engines");
  $("#engines-list").innerHTML = state.engines
    .map(
      (e) => `<div class="engine">
        <span class="dot ${e.available ? "ok" : "bad"}"></span>
        <span class="name">${esc(e.name)}</span>
        <span class="desc">${esc(e.capabilities.description)}</span>
        <span class="badge">${e.available ? esc(t("engine.available")) : esc(t("engine.install"))}</span>
      </div>`,
    )
    .join("");
  const avail = state.engines.filter((e) => e.available).map((e) => e.name).join(", ");
  $("#engines-summary").textContent = avail ? t("engines.summary", { list: avail }) : t("engines.none");
  fillSelects();
}

async function loadProxies() {
  state.proxies = await api("GET", "/api/proxies");
  $("#proxies-table tbody").innerHTML = state.proxies
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.server)}</td><td>${esc(p.country ?? "")}</td>
        <td class="actions-col"><span class="row-actions">
          <button class="ghost" data-test-proxy="${esc(p.id)}">${esc(t("common.test"))}</button>
          <button class="link danger" data-del-proxy="${esc(p.id)}">${esc(t("common.delete"))}</button>
        </span></td>
      </tr>`,
    )
    .join("");
  $("#proxies-empty").classList.toggle("hidden", state.proxies.length > 0);
  $("#proxies-empty").textContent = t("proxy.empty");
  fillSelects();
}

async function loadSettings() {
  state.settings = await api("GET", "/api/settings");
  const f = $("#settings-form");
  f.defaultEngine.value = state.settings.defaultEngine;
  f.defaultOs.value = state.settings.defaultOs ?? "";
  f.defaultProxyId.value = state.settings.defaultProxyId ?? "";
  f.headlessByDefault.checked = !!state.settings.headlessByDefault;
}

async function loadProfiles() {
  state.profiles = await api("GET", "/api/profiles");
  const ids = new Set(state.profiles.map((p) => p.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  updateFolderFilter();
  renderProfiles();
}

function updateFolderFilter() {
  const folders = [...new Set(state.profiles.map((p) => p.folder).filter(Boolean))].sort();
  const sel = $("#folder-filter");
  const cur = state.folder;
  sel.innerHTML = `<option value="">${esc(t("profiles.allFolders"))}</option>` + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  sel.value = folders.includes(cur) ? cur : "";
  state.folder = sel.value;
}

function visibleProfiles() {
  const q = state.search.toLowerCase();
  return state.profiles.filter((p) => {
    if (state.folder && p.folder !== state.folder) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || (p.tags ?? []).some((x) => x.toLowerCase().includes(q));
  });
}

function renderProfiles() {
  const rows = visibleProfiles();
  $("#profiles-table tbody").innerHTML = rows
    .map(
      (p) => `<tr>
        <td class="check-col"><input type="checkbox" data-select="${esc(p.id)}" ${state.selected.has(p.id) ? "checked" : ""} /></td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.folder ?? "")}</td>
        <td>${(p.tags ?? []).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</td>
        <td>${esc(p.engine)}</td>
        <td>${esc(p.os)}</td>
        <td>${esc(p.timezone)}</td>
        <td>${esc(p.proxy)}</td>
        <td><span class="badge ${p.running ? "running" : ""}">${p.running ? esc(t("status.running")) : esc(p.status || t("status.stopped"))}</span></td>
        <td class="actions-col"><span class="row-actions">
          ${
            p.running
              ? `<button class="ghost" data-stop="${esc(p.id)}">${esc(t("common.stop"))}</button><button class="ghost" data-type="${esc(p.id)}">${esc(t("row.type"))}</button>`
              : `<button class="primary" data-launch="${esc(p.id)}">${esc(t("common.launch"))}</button>`
          }
          <button class="ghost" data-check="${esc(p.id)}">${esc(t("row.check"))}</button>
          <button class="ghost" data-cookies="${esc(p.id)}">${esc(t("row.cookies"))}</button>
          <button class="ghost" data-edit="${esc(p.id)}">${esc(t("common.edit"))}</button>
          <button class="ghost" data-dupe="${esc(p.id)}">${esc(t("row.duplicate"))}</button>
          <button class="ghost danger" data-del="${esc(p.id)}">${esc(t("common.delete"))}</button>
        </span></td>
      </tr>`,
    )
    .join("");
  const empty = $("#profiles-empty");
  empty.classList.toggle("hidden", state.profiles.length > 0);
  empty.textContent = state.profiles.length ? t("profiles.noMatch") : t("profiles.empty");

  const ids = rows.map((p) => p.id);
  const allChecked = ids.length > 0 && ids.every((id) => state.selected.has(id));
  const selAll = $("#select-all");
  selAll.checked = allChecked;
  selAll.indeterminate = !allChecked && ids.some((id) => state.selected.has(id));
  $("#bulk-bar").classList.toggle("hidden", state.selected.size === 0);
  $("#bulk-count").textContent = t("bulk.selected", { n: state.selected.size });
}

/* --------------------------------------------------------------- editor --- */
async function openEditor(id) {
  const form = $("#editor-form");
  form.reset();
  form.id.value = "";
  $("#editor-title").textContent = t(id ? "editor.edit" : "editor.new");
  if (id) {
    const p = await api("GET", `/api/profiles/${id}`);
    form.name.value = p.name;
    form.engine.value = p.engine;
    form.os.value = p.os ?? "";
    form.timezone.value = p.timezone ?? "";
    form.locale.value = p.locale ?? "";
    form.proxyId.value = p.proxyId ?? "";
    form.folder.value = p.folder ?? "";
    form.status.value = p.status ?? "";
    form.tags.value = (p.tags ?? []).join(", ");
    form.extensions.value = (p.extensions ?? []).join("\n");
    form.notes.value = p.notes ?? "";
    form.id.value = p.id;
  }
  $("#editor").showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const form = $("#editor-form");
  const id = form.id.value;
  const overrides = {};
  if (form.os.value) overrides.os = form.os.value;
  if (form.timezone.value.trim()) overrides.timezone = form.timezone.value.trim();
  if (form.locale.value.trim()) overrides.locale = form.locale.value.trim();
  const payload = {
    name: form.name.value.trim(),
    engine: form.engine.value,
    proxyId: form.proxyId.value || null,
    folder: form.folder.value.trim(),
    status: form.status.value.trim(),
    tags: splitTags(form.tags.value),
    extensions: splitLines(form.extensions.value),
    notes: form.notes.value.trim(),
    overrides: Object.keys(overrides).length ? overrides : undefined,
  };
  try {
    if (id) await api("PATCH", `/api/profiles/${id}`, payload);
    else await api("POST", "/api/profiles", payload);
    $("#editor").close();
    await loadProfiles();
    toast(id ? t("toast.profileUpdated") : t("toast.profileCreated"));
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------- batch create --- */
function openBatch() {
  const form = $("#batch-form");
  form.reset();
  form.count.value = "5";
  form.namePattern.value = "profile-{n}";
  if (state.settings) {
    form.engine.value = state.settings.defaultEngine;
    form.os.value = state.settings.defaultOs ?? "";
    form.proxyId.value = state.settings.defaultProxyId ?? "";
  }
  $("#batch-dialog").showModal();
}

async function submitBatch(event) {
  event.preventDefault();
  const form = $("#batch-form");
  const overrides = {};
  if (form.os.value) overrides.os = form.os.value;
  try {
    const r = await api("POST", "/api/profiles/batch", {
      count: Number(form.count.value),
      namePattern: form.namePattern.value,
      engine: form.engine.value,
      proxyId: form.proxyId.value || null,
      folder: form.folder.value.trim(),
      tags: splitTags(form.tags.value),
      overrides: Object.keys(overrides).length ? overrides : undefined,
    });
    $("#batch-dialog").close();
    await loadProfiles();
    toast(`${t("profiles.batch")}: ${r.created}`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ----------------------------------------------------------- import/export -- */
async function exportProfiles() {
  const data = await api("GET", "/api/export");
  downloadJson(`fingerprint-profiles-${Date.now()}.json`, data);
  toast(t("toast.exported", { n: data.profiles.length }));
}

async function importProfiles(file) {
  const parsed = JSON.parse(await file.text());
  const profiles = Array.isArray(parsed) ? parsed : parsed.profiles;
  const r = await api("POST", "/api/import", { profiles });
  await loadProfiles();
  toast(t("toast.imported", { n: r.imported }));
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* -------------------------------------------------------------- cookies --- */
function openCookies(id) {
  $("#cookies-id").value = id;
  $("#cookies-title").textContent = t("data.title");
  $("#cookies-summary").textContent = t("data.summary");
  $("#cookies-dialog").showModal();
}
async function exportCookies(id) {
  const data = await api("GET", `/api/profiles/${id}/cookies`);
  downloadJson(`cookies-${id}.json`, data);
  $("#cookies-summary").textContent = t("toast.cookiesExported", { n: data.count });
  await loadActivity();
  return data.count;
}
async function importCookies(id, file) {
  const parsed = JSON.parse(await file.text());
  const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
  const r = await api("POST", `/api/profiles/${id}/cookies`, { cookies });
  $("#cookies-summary").textContent = t("toast.cookiesImported", { n: r.imported });
  await loadActivity();
  return r.imported;
}
async function exportBookmarks(id) {
  const data = await api("GET", `/api/profiles/${id}/bookmarks`);
  downloadJson(`bookmarks-${id}.json`, data.bookmarks ?? {});
  $("#cookies-summary").textContent = t("toast.bookmarksExported");
}
async function importBookmarks(id, file) {
  const bookmarks = JSON.parse(await file.text());
  await api("POST", `/api/profiles/${id}/bookmarks`, { bookmarks });
  $("#cookies-summary").textContent = t("toast.bookmarksImported");
  await loadActivity();
}

/* ------------------------------------------------------------ onboarding --- */
function isOnboarded() {
  return Boolean(state.settings?.onboarded);
}
function renderObEngines() {
  $("#ob-engines").innerHTML = state.engines
    .map(
      (e) => `<div class="engine">
        <span class="dot ${e.available ? "ok" : "bad"}"></span>
        <span class="name">${esc(e.name)}</span>
        <span class="desc">${esc(e.capabilities.description)}</span>
        ${e.available ? `<span class="badge">${esc(t("engine.available"))}</span>` : `<button class="ghost" data-install-engine="${esc(e.name)}">${esc(t("engine.install"))}</button>`}
      </div>`,
    )
    .join("");
}
function showObStep() {
  for (const n of [1, 2, 3]) $(`#ob-step${n}`).classList.toggle("hidden", state.obStep !== n);
  $("#ob-next").textContent = state.obStep === 3 ? t("ob.finish") : t("ob.next");
}
function maybeShowOnboarding() {
  if (!state.settings || isOnboarded()) return;
  renderObEngines();
  const obEngine = $("#ob-engine");
  obEngine.innerHTML = state.engines.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}</option>`).join("");
  obEngine.value = state.settings.defaultEngine ?? "chrome-lite";
  $("#ob-os").value = state.settings.defaultOs ?? "";
  state.obStep = 1;
  showObStep();
  const dialog = $("#onboarding");
  if (!dialog.open) dialog.showModal();
}
async function finishOnboarding() {
  const engine = $("#ob-engine").value;
  const os = $("#ob-os").value || null;
  const name = $("#ob-name").value.trim();
  try {
    await api("PATCH", "/api/settings", { onboarded: true, defaultEngine: engine, defaultOs: os });
    if (name) await api("POST", "/api/profiles", { name, engine });
    $("#onboarding").close();
    await refresh();
    toast(t("toast.setupComplete"));
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------------- team --- */
async function loadMe() {
  try {
    const me = await api("GET", "/api/me");
    $("#me-role").textContent = `${me.user} · ${t("role." + me.role)}`;
  } catch {
    $("#me-role").textContent = token ? "unauthorized" : "";
  }
}
async function loadUsers() {
  try { state.users = await api("GET", "/api/users"); } catch { state.users = []; }
  $("#users-table tbody").innerHTML = state.users
    .map(
      (u) => `<tr>
        <td>${esc(u.name)}</td><td>${esc(t("role." + u.role))}</td>
        <td>${esc(new Date(u.createdAt).toLocaleDateString())}</td>
        <td class="actions-col"><button class="link danger" data-del-user="${esc(u.id)}">${esc(t("common.delete"))}</button></td>
      </tr>`,
    )
    .join("");
  $("#users-empty").classList.toggle("hidden", state.users.length > 0);
}

/* -------------------------------------------------------------- activity --- */
async function loadActivity() {
  const events = await api("GET", "/api/activity?limit=100");
  $("#activity-list").innerHTML = events.length
    ? events
        .map((e) => {
          const target = e.profileName ? ` — ${esc(e.profileName)}` : e.message ? ` — ${esc(e.message)}` : "";
          return `<div class="ev"><span class="when">${esc(new Date(e.ts).toLocaleString())}</span><span class="t">${esc(e.type)}</span><span>${target}</span></div>`;
        })
        .join("")
    : `<span class="muted">${esc(t("activity.empty"))}</span>`;
}

/* -------------------------------------------------------------- actions --- */
async function withBusy(btn, fn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try { await fn(); }
  catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = prev; }
}

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "select-all") {
    for (const p of visibleProfiles()) (el.checked ? state.selected.add(p.id) : state.selected.delete(p.id));
    renderProfiles();
  } else if (el.dataset && el.dataset.select) {
    el.checked ? state.selected.add(el.dataset.select) : state.selected.delete(el.dataset.select);
    renderProfiles();
  } else if (el.id === "folder-filter") {
    state.folder = el.value;
    renderProfiles();
  }
});

async function runBulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === "move") {
    const folder = $("#bulk-folder").value.trim() || prompt(t("prompt.folder"));
    if (!folder) return toast(t("prompt.folder"), true);
    for (const id of ids) await api("PATCH", `/api/profiles/${id}`, { folder });
    await loadProfiles();
    return toast(t("toast.moved", { n: ids.length, folder }));
  }
  if (action === "syncType") {
    const text = prompt(t("prompt.syncType"));
    if (!text) return;
    const r = await api("POST", "/api/sync", { action: "type", ids, text });
    return toast(t("toast.syncDone", { action: t("bulk.syncType"), ok: r.total - r.failed, total: r.total }));
  }
  if (action === "syncGoto") {
    const url = prompt(t("prompt.syncGoto"));
    if (!url) return;
    const r = await api("POST", "/api/sync", { action: "goto", ids, url });
    return toast(t("toast.syncDone", { action: t("bulk.syncGoto"), ok: r.total - r.failed, total: r.total }));
  }
  if (action === "delete" && !confirm(t("confirm.deleteProfiles", { n: ids.length }))) return;
  const r = await api("POST", "/api/profiles/bulk", { action, ids });
  state.selected.clear();
  await loadProfiles();
  toast(t("toast.syncDone", { action, ok: r.total - r.failed, total: r.total }));
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const d = btn.dataset;
  try {
    if (d.bulk) await withBusy(btn, () => runBulk(d.bulk));
    else if (d.launch) await withBusy(btn, async () => { await api("POST", `/api/profiles/${d.launch}/launch`, {}); await loadProfiles(); toast(t("toast.launched")); });
    else if (d.stop) await withBusy(btn, async () => { await api("POST", `/api/profiles/${d.stop}/stop`, {}); await loadProfiles(); toast(t("toast.stopped")); });
    else if (d.edit) await openEditor(d.edit);
    else if (d.dupe) await withBusy(btn, async () => { await api("POST", `/api/profiles/${d.dupe}/duplicate`, {}); await loadProfiles(); toast(t("toast.duplicated")); });
    else if (d.del) await withBusy(btn, async () => {
      if (!confirm(t("confirm.deleteProfile"))) return;
      await api("DELETE", `/api/profiles/${d.del}`);
      await loadProfiles();
      toast(t("toast.deleted"));
    });
    else if (d.check) await withBusy(btn, async () => {
      const r = await api("POST", `/api/profiles/${d.check}/check`, { headless: true });
      const failed = r.signalChecks.filter((c) => !c.ok).map((c) => c.field);
      toast(t("toast.selfCheck", { score: r.signalScore }) + (failed.length ? ` — ${failed.join(", ")}` : ""));
    });
    else if (d.cookies) openCookies(d.cookies);
    else if (d.testProxy) await withBusy(btn, async () => {
      const r = await api("POST", `/api/proxies/${d.testProxy}/test`);
      toast(r.reachable ? t("toast.proxyReachable", { ms: r.ms }) : t("toast.proxyUnreachable", { err: r.error ?? "?" }), !r.reachable);
    });
    else if (d.delProxy) await withBusy(btn, async () => { await api("DELETE", `/api/proxies/${d.delProxy}`); await loadProxies(); toast(t("toast.proxyDeleted")); });
    else if (d.delUser) await withBusy(btn, async () => { await api("DELETE", `/api/users/${d.delUser}`); await loadUsers(); toast(t("toast.userDeleted")); });
    else if (d.installEngine) await withBusy(btn, async () => {
      toast(t("toast.installing", { engine: d.installEngine }));
      const r = await api("POST", `/api/engines/${d.installEngine}/install`, {});
      await loadEngines();
      renderObEngines();
      toast(r.available ? t("toast.engineReady", { engine: d.installEngine }) : t("toast.installFinished", { code: r.code, reason: r.reason ?? "" }), !r.available);
    });
    else if (d.type) await withBusy(btn, async () => {
      const text = prompt(t("prompt.type"));
      if (!text) return;
      await api("POST", `/api/profiles/${d.type}/type`, { text });
      toast(t("toast.typed", { n: text.length }));
    });
  } catch (err) {
    toast(err.message, true);
  }
});

/* --------------------------------------------------------------- wiring --- */
$("#new-profile").addEventListener("click", () => openEditor(null).catch((e) => toast(e.message, true)));
$("#batch-profile").addEventListener("click", openBatch);
$("#editor-cancel").addEventListener("click", () => $("#editor").close());
$("#batch-cancel").addEventListener("click", () => $("#batch-dialog").close());
$("#editor-form").addEventListener("submit", saveEditor);
$("#batch-form").addEventListener("submit", submitBatch);
$("#export-btn").addEventListener("click", () => exportProfiles().catch((e) => toast(e.message, true)));
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importProfiles(file).catch((err) => toast(err.message, true));
  e.target.value = "";
});
$("#proxy-export").addEventListener("click", async () => {
  try { const data = await api("GET", "/api/proxies/export"); downloadJson(`proxies-${Date.now()}.json`, data); toast(t("toast.exported", { n: data.proxies.length })); }
  catch (err) { toast(err.message, true); }
});
$("#proxy-import-btn").addEventListener("click", () => $("#proxy-import-file").click());
$("#proxy-import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    try {
      const parsed = JSON.parse(await file.text());
      const proxies = Array.isArray(parsed) ? parsed : parsed.proxies;
      const r = await api("POST", "/api/proxies/import", { proxies });
      await loadProxies();
      toast(t("toast.proxyAdded") + ` (${r.imported})`);
    } catch (err) { toast(err.message, true); }
  }
  e.target.value = "";
});
$("#search").addEventListener("input", (e) => { state.search = e.target.value.trim(); renderProfiles(); });
$("#clear-activity").addEventListener("click", async () => { await api("DELETE", "/api/activity"); await loadActivity(); toast(t("toast.activityCleared")); });
$("#refresh").addEventListener("click", () => refresh().then(() => toast(t("toast.refreshed"))).catch((e) => toast(e.message, true)));

$("#set-token").addEventListener("click", () => {
  const next = prompt(t("prompt.token"), token);
  if (next === null) return;
  token = next.trim();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  refresh().then(() => toast(token ? t("toast.tokenSet") : t("toast.tokenCleared"))).catch((err) => toast(err.message, true));
});

$("#cookies-cancel").addEventListener("click", () => $("#cookies-dialog").close());
$("#cookies-export").addEventListener("click", async () => {
  const id = $("#cookies-id").value;
  try { const n = await exportCookies(id); toast(t("toast.cookiesExported", { n })); } catch (e) { toast(e.message, true); }
});
$("#cookies-import").addEventListener("click", () => $("#cookies-file").click());
$("#cookies-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const id = $("#cookies-id").value;
  if (file) { try { const n = await importCookies(id, file); toast(t("toast.cookiesImported", { n })); } catch (err) { toast(err.message, true); } }
  e.target.value = "";
});
$("#bookmarks-export").addEventListener("click", async () => {
  try { await exportBookmarks($("#cookies-id").value); toast(t("toast.bookmarksExported")); } catch (e) { toast(e.message, true); }
});
$("#bookmarks-import").addEventListener("click", () => $("#bookmarks-file").click());
$("#bookmarks-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const id = $("#cookies-id").value;
  if (file) { try { await importBookmarks(id, file); toast(t("toast.bookmarksImported")); } catch (err) { toast(err.message, true); } }
  e.target.value = "";
});

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const created = await api("POST", "/api/users", { name: f.name.value.trim(), role: f.role.value, token: f.token.value.trim() || undefined });
    f.reset();
    await loadUsers();
    toast(t("toast.userCreated", { name: created.name, token: created.token }));
  } catch (err) { toast(err.message, true); }
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("PATCH", "/api/settings", {
      defaultEngine: f.defaultEngine.value,
      defaultOs: f.defaultOs.value || null,
      defaultProxyId: f.defaultProxyId.value || null,
      headlessByDefault: f.headlessByDefault.checked,
    });
    await loadSettings();
    toast(t("toast.settingsSaved"));
  } catch (err) { toast(err.message, true); }
});

$("#proxy-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api("POST", "/api/proxies", { server: form.server.value.trim(), name: form.name.value.trim() || undefined, country: form.country.value.trim() || undefined });
    form.reset();
    await loadProxies();
    toast(t("toast.proxyAdded"));
  } catch (err) { toast(err.message, true); }
});

$("#ob-recheck").addEventListener("click", () => loadEngines().then(renderObEngines).catch((e) => toast(e.message, true)));
$("#ob-next").addEventListener("click", () => {
  if (state.obStep < 3) { state.obStep += 1; showObStep(); } else finishOnboarding();
});
$("#ob-skip").addEventListener("click", async () => {
  try { await api("PATCH", "/api/settings", { onboarded: true }); state.settings = { ...state.settings, onboarded: true }; } catch { /* ignore */ }
  $("#onboarding").close();
});
$("#onboarding").addEventListener("cancel", (e) => e.preventDefault());

/* --------------------------------------------------------------- language -- */
function initLangSelect() {
  const sel = $("#lang");
  sel.innerHTML = getLangs().map((l) => `<option value="${l}">${langLabel(l)}</option>`).join("");
  sel.value = getLang();
  sel.addEventListener("change", async () => {
    setLang(sel.value);
    applyStatic();
    document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
    await refresh();
  });
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
}

async function refresh() {
  await loadEngines();
  await loadProxies();
  await loadSettings();
  await loadProfiles();
  await loadMe();
  await loadUsers();
  await loadActivity();
  maybeShowOnboarding();
}

applyStatic();
initLangSelect();
refresh().catch((e) => toast(e.message, true));
setInterval(() => loadProfiles().catch(() => {}), 4000);
setInterval(() => loadActivity().catch(() => {}), 8000);
