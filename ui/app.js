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
const splitTags = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);
const splitLines = (s) => s.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

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
    `<option value="">(direct)</option>` +
    state.proxies.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.server)}</option>`).join("");
  for (const sel of $$('select[name="engine"]')) {
    const cur = sel.value;
    sel.innerHTML = engineOpts;
    if (cur) sel.value = cur;
  }
  for (const sel of $$('select[name="proxyId"]')) {
    const cur = sel.value;
    sel.innerHTML = proxyOpts;
    if (cur) sel.value = cur;
  }
  const defProxy = document.querySelector('#settings-form select[name="defaultProxyId"]');
  if (defProxy) {
    const cur = defProxy.value;
    defProxy.innerHTML = proxyOpts;
    if (cur) defProxy.value = cur;
  }
}

async function loadEngines() {
  state.engines = await api("GET", "/api/engines");
  $("#engines-list").innerHTML = state.engines
    .map(
      (e) => `<div class="engine">
        <span class="dot ${e.available ? "ok" : "bad"}"></span>
        <span class="name">${esc(e.name)}</span>
        <span class="desc">${esc(e.capabilities.description)}</span>
        <span class="badge">${e.available ? "available" : "unavailable"}</span>
      </div>`,
    )
    .join("");
  const avail = state.engines.filter((e) => e.available).map((e) => e.name).join(", ");
  $("#engines-summary").textContent = avail ? `engines: ${avail}` : "no engines available";
  fillSelects();
}

async function loadProxies() {
  state.proxies = await api("GET", "/api/proxies");
  $("#proxies-table tbody").innerHTML = state.proxies
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.server)}</td><td>${esc(p.country ?? "")}</td>
        <td class="actions-col"><span class="row-actions">
          <button class="ghost" data-test-proxy="${esc(p.id)}">Test</button>
          <button class="link danger" data-del-proxy="${esc(p.id)}">Delete</button>
        </span></td>
      </tr>`,
    )
    .join("");
  $("#proxies-empty").classList.toggle("hidden", state.proxies.length > 0);
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
  // Drop selections for profiles that no longer exist.
  const ids = new Set(state.profiles.map((p) => p.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  updateFolderFilter();
  renderProfiles();
}

function updateFolderFilter() {
  const folders = [...new Set(state.profiles.map((p) => p.folder).filter(Boolean))].sort();
  const sel = $("#folder-filter");
  const cur = state.folder;
  sel.innerHTML = `<option value="">All folders</option>` + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  sel.value = folders.includes(cur) ? cur : "";
  state.folder = sel.value;
}

function renderProfiles() {
  const q = state.search.toLowerCase();
  const rows = state.profiles.filter((p) => {
    if (state.folder && p.folder !== state.folder) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || (p.tags ?? []).some((t) => t.toLowerCase().includes(q));
  });
  $("#profiles-table tbody").innerHTML = rows
    .map(
      (p) => `<tr>
        <td class="check-col"><input type="checkbox" data-select="${esc(p.id)}" ${state.selected.has(p.id) ? "checked" : ""} /></td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.folder ?? "")}</td>
        <td>${(p.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</td>
        <td>${esc(p.engine)}</td>
        <td>${esc(p.os)}</td>
        <td>${esc(p.timezone)}</td>
        <td>${esc(p.proxy)}</td>
        <td><span class="badge ${p.running ? "running" : ""}">${p.running ? "running" : esc(p.status || "stopped")}</span></td>
        <td class="actions-col"><span class="row-actions">
          ${
            p.running
              ? `<button class="ghost" data-stop="${esc(p.id)}">Stop</button><button class="ghost" data-type="${esc(p.id)}">Type…</button>`
              : `<button class="primary" data-launch="${esc(p.id)}">Launch</button>`
          }
          <button class="ghost" data-check="${esc(p.id)}">Check</button>
          <button class="ghost" data-cookies="${esc(p.id)}">Cookies</button>
          <button class="ghost" data-edit="${esc(p.id)}">Edit</button>
          <button class="ghost" data-dupe="${esc(p.id)}">Duplicate</button>
          <button class="ghost danger" data-del="${esc(p.id)}">Delete</button>
        </span></td>
      </tr>`,
    )
    .join("");
  $("#profiles-empty").classList.toggle("hidden", state.profiles.length > 0);
  $("#profiles-empty").textContent = state.profiles.length ? "No profiles match your filter." : "No profiles yet. Create one to get started.";

  const visibleIds = rows.map((p) => p.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  const selAll = $("#select-all");
  selAll.checked = allChecked;
  selAll.indeterminate = !allChecked && visibleIds.some((id) => state.selected.has(id));

  $("#bulk-bar").classList.toggle("hidden", state.selected.size === 0);
  $("#bulk-count").textContent = `${state.selected.size} selected`;
}

/* --------------------------------------------------------------- editor --- */
async function openEditor(id) {
  const dialog = $("#editor");
  const form = $("#editor-form");
  form.reset();
  form.id.value = "";
  $("#editor-title").textContent = id ? "Edit profile" : "New profile";
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
  dialog.showModal();
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
    toast(id ? "Profile updated" : "Profile created");
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
    toast(`Created ${r.created} profiles`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ----------------------------------------------------------- import/export -- */
async function exportProfiles() {
  const data = await api("GET", "/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fingerprint-profiles-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${data.profiles.length} profiles`);
}

async function importProfiles(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const profiles = Array.isArray(parsed) ? parsed : parsed.profiles;
  const r = await api("POST", "/api/import", { profiles });
  await loadProfiles();
  toast(`Imported ${r.imported} profiles`);
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
        ${e.available ? `<span class="badge">available</span>` : `<button class="ghost" data-install-engine="${esc(e.name)}">Install</button>`}
      </div>`,
    )
    .join("");
}

function showObStep() {
  for (const n of [1, 2, 3]) $(`#ob-step${n}`).classList.toggle("hidden", state.obStep !== n);
  $("#ob-next").textContent = state.obStep === 3 ? "Finish" : "Next";
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
    toast("Setup complete");
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------------- team --- */
async function loadMe() {
  try {
    const me = await api("GET", "/api/me");
    $("#me-role").textContent = `${me.user} · ${me.role}`;
  } catch {
    $("#me-role").textContent = token ? "unauthorized" : "";
  }
}

async function loadUsers() {
  try {
    state.users = await api("GET", "/api/users");
  } catch {
    state.users = [];
  }
  $("#users-table tbody").innerHTML = state.users
    .map(
      (u) => `<tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.role)}</td>
        <td>${esc(new Date(u.createdAt).toLocaleDateString())}</td>
        <td class="actions-col"><button class="link danger" data-del-user="${esc(u.id)}">Delete</button></td>
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
    : `<span class="muted">No activity yet.</span>`;
}

/* -------------------------------------------------------------- cookies --- */
const COOKIE_DEFAULT = "Import or export this profile's cookies as JSON.";

function openCookies(id) {
  $("#cookies-id").value = id;
  $("#cookies-title").textContent = `Cookies — ${id}`;
  $("#cookies-summary").textContent = COOKIE_DEFAULT;
  $("#cookies-dialog").showModal();
}

async function exportCookies(id) {
  const data = await api("GET", `/api/profiles/${id}/cookies`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cookies-${id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $("#cookies-summary").textContent = `Exported ${data.count} cookies.`;
  await loadActivity();
  return data.count;
}

async function importCookies(id, file) {
  const parsed = JSON.parse(await file.text());
  const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
  const r = await api("POST", `/api/profiles/${id}/cookies`, { cookies });
  $("#cookies-summary").textContent = `Imported ${r.imported} cookies.`;
  await loadActivity();
  return r.imported;
}

async function exportBookmarks(id) {
  const data = await api("GET", `/api/profiles/${id}/bookmarks`);
  const blob = new Blob([JSON.stringify(data.bookmarks ?? {}, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bookmarks-${id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $("#cookies-summary").textContent = data.bookmarks ? "Exported bookmarks." : "No bookmarks stored (exported empty).";
}

async function importBookmarks(id, file) {
  const bookmarks = JSON.parse(await file.text());
  await api("POST", `/api/profiles/${id}/bookmarks`, { bookmarks });
  $("#cookies-summary").textContent = "Imported bookmarks.";
  await loadActivity();
}

/* -------------------------------------------------------------- actions --- */
async function withBusy(btn, fn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "select-all") {
    const q = state.search.toLowerCase();
    const visible = state.profiles.filter((p) => {
      if (state.folder && p.folder !== state.folder) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.tags ?? []).some((x) => x.toLowerCase().includes(q));
    });
    for (const p of visible) t.checked ? state.selected.add(p.id) : state.selected.delete(p.id);
    renderProfiles();
  } else if (t.dataset && t.dataset.select) {
    t.checked ? state.selected.add(t.dataset.select) : state.selected.delete(t.dataset.select);
    renderProfiles();
  } else if (t.id === "folder-filter") {
    state.folder = t.value;
    renderProfiles();
  }
});

async function runBulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === "move") {
    const folder = $("#bulk-folder").value.trim();
    if (!folder) return toast("Enter a folder name", true);
    for (const id of ids) await api("PATCH", `/api/profiles/${id}`, { folder });
    await loadProfiles();
    return toast(`Moved ${ids.length} to "${folder}"`);
  }
  if (action === "syncType") {
    const text = prompt("Text to type in all selected running profiles:");
    if (!text) return;
    const r = await api("POST", "/api/sync", { action: "type", ids, text });
    return toast(`sync type: ${r.total - r.failed}/${r.total} ok`);
  }
  if (action === "syncGoto") {
    const url = prompt("URL to open in all selected running profiles:");
    if (!url) return;
    const r = await api("POST", "/api/sync", { action: "goto", ids, url });
    return toast(`sync goto: ${r.total - r.failed}/${r.total} ok`);
  }
  if (action === "delete" && !confirm(`Delete ${ids.length} profiles?`)) return;
  const r = await api("POST", "/api/profiles/bulk", { action, ids });
  state.selected.clear();
  await loadProfiles();
  toast(`${action}: ${r.total - r.failed}/${r.total} ok`);
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.bulk) await withBusy(t, () => runBulk(d.bulk));
    else if (d.launch) await withBusy(t, async () => { await api("POST", `/api/profiles/${d.launch}/launch`, {}); await loadProfiles(); toast("Launched"); });
    else if (d.stop) await withBusy(t, async () => { await api("POST", `/api/profiles/${d.stop}/stop`, {}); await loadProfiles(); toast("Stopped"); });
    else if (d.edit) await openEditor(d.edit);
    else if (d.dupe) await withBusy(t, async () => { await api("POST", `/api/profiles/${d.dupe}/duplicate`, {}); await loadProfiles(); toast("Duplicated"); });
    else if (d.del) await withBusy(t, async () => {
      if (!confirm("Delete this profile?")) return;
      await api("DELETE", `/api/profiles/${d.del}`);
      await loadProfiles();
      toast("Deleted");
    });
    else if (d.check) await withBusy(t, async () => {
      const r = await api("POST", `/api/profiles/${d.check}/check`, { headless: true });
      const failed = r.signalChecks.filter((c) => !c.ok).map((c) => c.field);
      toast(`Self-check: ${r.signalScore}/100${failed.length ? ` — failed: ${failed.join(", ")}` : ""}`);
    });
    else if (d.cookies) openCookies(d.cookies);
    else if (d.delProxy) await withBusy(t, async () => {
      await api("DELETE", `/api/proxies/${d.delProxy}`);
      await loadProxies();
      toast("Proxy deleted");
    });
    else if (d.testProxy) await withBusy(t, async () => {
      const r = await api("POST", `/api/proxies/${d.testProxy}/test`);
      toast(r.reachable ? `Proxy reachable (${r.ms}ms)` : `Proxy unreachable: ${r.error ?? "unknown"}`, !r.reachable);
    });
    else if (d.delUser) await withBusy(t, async () => {
      await api("DELETE", `/api/users/${d.delUser}`);
      await loadUsers();
      toast("User deleted");
    });
    else if (d.installEngine) await withBusy(t, async () => {
      toast(`Installing ${d.installEngine}… this can take several minutes`);
      const r = await api("POST", `/api/engines/${d.installEngine}/install`, {});
      await loadEngines();
      renderObEngines();
      toast(r.available ? `${d.installEngine} ready` : `Install finished (exit ${r.code}): ${r.reason ?? ""}`, !r.available);
    });
    else if (d.type) await withBusy(t, async () => {
      const text = prompt("Text to type (human-like):");
      if (!text) return;
      await api("POST", `/api/profiles/${d.type}/type`, { text });
      toast(`Typed ${text.length} chars`);
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
$("#search").addEventListener("input", (e) => { state.search = e.target.value.trim(); renderProfiles(); });
$("#clear-activity").addEventListener("click", async () => { await api("DELETE", "/api/activity"); await loadActivity(); toast("Activity cleared"); });
$("#refresh").addEventListener("click", () => refresh().then(() => toast("Refreshed")).catch((e) => toast(e.message, true)));

$("#cookies-cancel").addEventListener("click", () => $("#cookies-dialog").close());
$("#cookies-export").addEventListener("click", async () => {
  const id = $("#cookies-id").value;
  try { const n = await exportCookies(id); toast(`Exported ${n} cookies`); } catch (e) { toast(e.message, true); }
});
$("#cookies-import").addEventListener("click", () => $("#cookies-file").click());
$("#cookies-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const id = $("#cookies-id").value;
  if (file) {
    try { const n = await importCookies(id, file); toast(`Imported ${n} cookies`); } catch (err) { toast(err.message, true); }
  }
  e.target.value = "";
});

$("#bookmarks-export").addEventListener("click", async () => {
  const id = $("#cookies-id").value;
  try { await exportBookmarks(id); toast("Exported bookmarks"); } catch (e) { toast(e.message, true); }
});
$("#bookmarks-import").addEventListener("click", () => $("#bookmarks-file").click());
$("#bookmarks-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const id = $("#cookies-id").value;
  if (file) {
    try { await importBookmarks(id, file); toast("Imported bookmarks"); } catch (err) { toast(err.message, true); }
  }
  e.target.value = "";
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
    toast("Settings saved");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#proxy-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api("POST", "/api/proxies", {
      server: form.server.value.trim(),
      name: form.name.value.trim() || undefined,
      country: form.country.value.trim() || undefined,
    });
    form.reset();
    await loadProxies();
    toast("Proxy added");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#proxy-export").addEventListener("click", async () => {
  try {
    const data = await api("GET", "/api/proxies/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `proxies-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${data.proxies.length} proxies`);
  } catch (err) {
    toast(err.message, true);
  }
});
$("#proxy-import-btn").addEventListener("click", () => $("#proxy-import-file").click());$("#proxy-import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    try {
      const parsed = JSON.parse(await file.text());
      const proxies = Array.isArray(parsed) ? parsed : parsed.proxies;
      const r = await api("POST", "/api/proxies/import", { proxies });
      await loadProxies();
      toast(`Imported ${r.imported} proxies`);
    } catch (err) {
      toast(err.message, true);
    }
  }
  e.target.value = "";
});

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const created = await api("POST", "/api/users", {
      name: f.name.value.trim(),
      role: f.role.value,
      token: f.token.value.trim() || undefined,
    });
    f.reset();
    await loadUsers();
    toast(`User ${created.name} created — token: ${created.token}`);
  } catch (err) {
    toast(err.message, true);
  }
});

$("#set-token").addEventListener("click", () => {
  const next = prompt("API token (leave empty to clear):", token);
  if (next === null) return;
  token = next.trim();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  refresh().then(() => toast(token ? "Token set" : "Token cleared")).catch((err) => toast(err.message, true));
});

$("#ob-recheck").addEventListener("click", () => loadEngines().then(renderObEngines).catch((e) => toast(e.message, true)));
$("#ob-next").addEventListener("click", () => {
  if (state.obStep < 3) {
    state.obStep += 1;
    showObStep();
  } else {
    finishOnboarding();
  }
});
$("#ob-skip").addEventListener("click", async () => {
  try {
    await api("PATCH", "/api/settings", { onboarded: true });
    state.settings = { ...state.settings, onboarded: true };
  } catch {
    /* ignore */
  }
  $("#onboarding").close();
});
$("#onboarding").addEventListener("cancel", (e) => e.preventDefault());

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

refresh().catch((e) => toast(e.message, true));
setInterval(() => loadProfiles().catch(() => {}), 4000);
setInterval(() => loadActivity().catch(() => {}), 8000);
