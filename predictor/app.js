"use strict";

// PadML Predictor front end. Plain DOM; untrusted text is only ever set via textContent.

const state = {
  models: [],
  parameters: [],
  model: null,
  references: [],
  baseline: null,
  history: [],
  batchRows: [],
};

const GROUPS = [
  ["Pad", ["pad_width_in", "pad_height_in"]],
  ["Interfaces", ["interface_bottom_in", "interface_top_in"]],
  ["Lower legs", ["strut_width_lower_in", "angle_lower_deg"]],
  ["Upper legs", ["strut_width_upper_in", "angle_upper_deg"]],
  ["Apex and junction", ["apex_offset_in", "junction"]],
];
const STEPS = { deg: 0.5, apex_offset_in: 0.001 };
const JUNCTION_LABELS = {
  struts: "Struts fill the junction (e.g. S012)",
  pockets: "Side pockets cut to the band (e.g. S010)",
};

// ---------- small helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 3) => (value === null || value === undefined || Number.isNaN(value)) ? "—" : Number(value).toFixed(digits);

const API_BASE = String((window.PADML_CONFIG && window.PADML_CONFIG.apiBase) || "").replace(/\/+$/, "");
const PASSWORD_KEY = "padml-predictor-password";

function askPassword(message) {
  // Resolves once the user submits; the password is checked by the next request.
  return new Promise((resolve) => {
    const dialog = $("login-dialog");
    showError("login-error", message || "");
    $("login-password").value = "";
    const done = (event) => {
      event.preventDefault();
      sessionStorage.setItem(PASSWORD_KEY, $("login-password").value);
      $("login-form").removeEventListener("submit", done);
      dialog.close();
      resolve();
    };
    $("login-form").addEventListener("submit", done);
    dialog.addEventListener("cancel", (event) => event.preventDefault(), { once: true });
    if (!dialog.open) dialog.showModal();
    $("login-password").focus();
  });
}

async function rawRequest(path, body) {
  for (let attempt = 0; ; attempt++) {
    const headers = {};
    const saved = sessionStorage.getItem(PASSWORD_KEY);
    if (saved) headers["X-Predictor-Password"] = saved;
    const options = { headers };
    if (body !== undefined) {
      options.method = "POST";
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(API_BASE + path, options);
    if (response.status !== 401) return response;
    sessionStorage.removeItem(PASSWORD_KEY);
    await askPassword(attempt || saved ? "That password was not accepted. Try again." : "");
  }
}

async function api(path, body) {
  const response = await rawRequest(path, body);
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok) {
    const error = new Error((data && data.error) || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function downloadTemplate() {
  const response = await rawRequest("/api/template.csv");
  if (!response.ok) { showError("batch-error", "Could not download the template."); return; }
  const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/csv" }));
  const link = el("a", { href: url, download: "padml_batch_template.csv" });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message || "";
  node.hidden = !message;
}

function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/csv" }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- tabs ----------
function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const other of tabs) {
      const active = other === tab;
      other.setAttribute("aria-selected", String(active));
      other.tabIndex = active ? 0 : -1;
      $(other.getAttribute("aria-controls")).hidden = !active;
    }
    tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") select(tabs[(index + 1) % tabs.length]);
      if (event.key === "ArrowLeft") select(tabs[(index - 1 + tabs.length) % tabs.length]);
    });
  });
}

// ---------- parameter form ----------
function buildForm() {
  const container = $("param-fields");
  container.replaceChildren();
  if (state.model && state.model.input_kind === "recurved_doe") {
    const parameters = state.model.parameter_order.map((name) => ({
      name, label: name.replaceAll("_", " "),
      min: state.model.input_ranges[name].min, max: state.model.input_ranges[name].max,
      default: state.model.fixed_parameters?.[name] ?? state.model.input_ranges[name].min,
      fixed: state.model.fixed_parameters?.[name],
    }));
    for (const p of parameters) {
      const id = `param-${p.name}`;
      const fixed = p.fixed !== undefined;
      const input = el("input", { id, name: p.name, type: "number", min: p.min, max: p.max,
        step: p.name.endsWith("_deg") ? 1 : 0.001, value: fixed ? p.fixed : p.default,
        required: true, ...(fixed ? { readOnly: true } : {}), "aria-describedby": `${id}-range` });
      input.addEventListener("input", () => { if (!fixed) showError("form-error", ""); });
      container.append(el("div", { class: "field-row" }, el("label", { for: id, text: `${p.label}${p.name.endsWith("_deg") ? " (deg)" : p.name.endsWith("_in") ? " (in)" : ""}` }), input,
        el("span", { class: "range", id: `${id}-range`, text: fixed ? `Fixed at ${p.fixed} in` : `Tested ${p.min} to ${p.max}` })));
    }
    return;
  }
  const byName = Object.fromEntries(state.parameters.map((p) => [p.name, p]));
  for (const [legend, names] of GROUPS) {
    const fieldset = el("fieldset", {}, el("legend", { text: legend }));
    for (const name of names) {
      const p = byName[name];
      if (!p) continue;
      const id = `param-${name}`;
      let input;
      if (p.choices) {
        input = el("select", { id, name }, p.choices.map((c) => el("option", { value: c, text: JUNCTION_LABELS[c] || c })));
        input.value = p.default;
      } else {
        const step = name.endsWith("_deg") ? STEPS.deg : (STEPS[name] || 0.005);
        input = el("input", { id, name, type: "number", min: p.min, max: p.max, step, value: p.default, required: true,
                              "aria-describedby": `${id}-range` });
      }
      input.addEventListener("input", () => {
        // Once edited, the design is no longer the tested one it started from.
        if (!state.loadingReference) $("load-reference").value = "";
        schedulePreview();
      });
      fieldset.append(el("div", { class: p.choices ? "field-row wide" : "field-row" },
        el("label", { for: id, text: p.label }), input,
        p.choices ? null : el("span", { class: "range", id: `${id}-range`, text: `Allowed ${p.min} to ${p.max}` })));
    }
    container.append(fieldset);
  }
}

function readParams() {
  const params = {};
  if (state.model?.input_kind === "recurved_doe") {
    for (const name of state.model.parameter_order) {
      const input = $(`param-${name}`); const value = Number(input.value);
      input.removeAttribute("aria-invalid");
      const bounds = state.model.input_ranges[name];
      if (input.value === "" || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
        input.setAttribute("aria-invalid", "true");
        throw new Error(`${name} must be between ${bounds.min} and ${bounds.max}.`);
      }
      params[name] = value;
    }
    return params;
  }
  for (const p of state.parameters) {
    const input = $(`param-${p.name}`);
    input.removeAttribute("aria-invalid");
    if (p.choices) { params[p.name] = input.value; continue; }
    const value = Number(input.value);
    if (input.value === "" || !Number.isFinite(value) || value < p.min || value > p.max) {
      input.setAttribute("aria-invalid", "true");
      throw new Error(`${p.label} must be between ${p.min} and ${p.max}.`);
    }
    params[p.name] = value;
  }
  return params;
}

function writeParams(params) {
  for (const p of state.parameters) {
    if (params[p.name] === undefined || params[p.name] === "") continue;
    const input = $(`param-${p.name}`);
    input.value = p.choices ? params[p.name] : Number(Number(params[p.name]).toFixed(4));
  }
  schedulePreview();
}

// ---------- preview ----------
function drawOutline(target, outline) {
  const container = $(target);
  container.replaceChildren();
  if (!outline) return;
  const pad = 0.08 * Math.max(outline.width_in, outline.height_in);
  const w = outline.width_in, h = outline.height_in;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const toPath = (ring) => ring.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(5)} ${(h - y).toFixed(5)}`).join(" ") + " Z";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", [outline.exterior, ...outline.holes].map(toPath).join(" "));
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("class", "material");
  svg.append(path);
  if (outline.apex_y_in !== undefined) {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", -pad / 2); line.setAttribute("x2", w + pad / 2);
    line.setAttribute("y1", h - outline.apex_y_in); line.setAttribute("y2", h - outline.apex_y_in);
    line.setAttribute("class", "apex");
    svg.append(line);
  }
  const title = document.createElementNS(ns, "title");
  title.textContent = `Pad ${w.toFixed(3)} by ${h.toFixed(3)} in`;
  svg.prepend(title);
  container.append(svg);
}

let previewTimer = null;
function schedulePreview() {
  if (state.model?.input_kind === "recurved_doe") return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    let params;
    try { params = readParams(); showError("form-error", ""); }
    catch (error) { showError("form-error", error.message); return; }
    try {
      const data = await api("/api/preview", { params });
      drawOutline("preview", data.outline);
      showError("form-error", "");
    } catch (error) {
      showError("form-error", error.message);
    }
  }, 200);
}

// ---------- force-displacement chart ----------
state.chartView = "plateau";
const CHART_VIEWS = { plateau: "Plateau close-up", full: "Full curve", log: "Log force" };

function chartPanel(series, { title = "Force-displacement curve", markers = [], download = null } = {}) {
  const holder = el("div", { class: "chart-panel" });
  const draw = () => {
    holder.querySelector(".chart")?.replaceWith(drawChart(series, markers));
  };
  const viewId = `view-${Math.random().toString(36).slice(2)}`;
  const view = el("select", { id: viewId, onchange: (e) => { state.chartView = e.target.value; draw(); } },
    Object.entries(CHART_VIEWS).map(([value, text]) => el("option", { value, text })));
  view.value = state.chartView;
  const toggle = el("span", { class: "inline" }, el("label", { for: viewId, text: "View" }), view);
  const legend = el("ul", { class: "legend" }, series.map((s) => el("li", {}, el("span", { class: `swatch ${s.cls}` }), s.label)));
  holder.append(el("div", { class: "chart-head" }, el("h3", { text: title }), toggle,
    download ? el("button", { type: "button", onclick: download, text: "Download curve CSV" }) : null),
  el("div", { class: "chart" }), legend);
  draw();
  return holder;
}

function drawChart(series, markers) {
  const ns = "http://www.w3.org/2000/svg";
  const W = 640, H = 340, L = 62, R = 14, T = 12, B = 42;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Force versus displacement");
  const node = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    svg.append(n);
    return n;
  };
  const xs = series.flatMap((s) => s.x);
  const ys = series.flatMap((s) => [...s.y, ...(s.high || [])]).filter((v) => v > 0);
  const xmax = Math.max(...xs);
  const log = state.chartView === "log";
  const ymin = log ? Math.max(0.5, Math.min(...ys)) : 0;
  let ymax = Math.max(...ys) * (log ? 1.5 : 1.05);
  if (state.chartView === "plateau") {
    // Scale to the plateau: four times the highest median force over the first 60% of the stroke.
    const level = Math.max(...series.map((s) => {
      const early = s.y.filter((_, i) => s.x[i] <= 0.6 * xmax).sort((a, b) => a - b);
      return early.length ? early[Math.floor(early.length / 2)] : 0;
    }));
    if (level > 0) ymax = Math.min(ymax, 4 * level);
  }
  const clipId = `clip-${Math.random().toString(36).slice(2)}`;
  const defs = document.createElementNS(ns, "defs");
  const clip = document.createElementNS(ns, "clipPath");
  clip.setAttribute("id", clipId);
  const rect = document.createElementNS(ns, "rect");
  for (const [k, v] of Object.entries({ x: L, y: T, width: W - L - R, height: H - T - B })) rect.setAttribute(k, v);
  clip.append(rect); defs.append(clip); svg.append(defs);
  const tx = (x) => L + (x / xmax) * (W - L - R);
  const ty = (y) => {
    const v = log ? (Math.log10(Math.max(y, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) : y / ymax;
    return H - B - v * (H - T - B);
  };
  // grid and ticks
  const xticks = [...Array(9).keys()].map((i) => (i * xmax) / 8);
  const yticks = log
    ? [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((v) => v >= ymin && v <= ymax)
    : [...Array(6).keys()].map((i) => (i * ymax) / 5);
  for (const x of xticks) {
    node("line", { x1: tx(x), x2: tx(x), y1: T, y2: H - B, class: "gridline" });
    node("text", { x: tx(x), y: H - B + 16, "text-anchor": "middle", class: "tick" }, x.toFixed(2));
  }
  for (const y of yticks) {
    node("line", { x1: L, x2: W - R, y1: ty(y), y2: ty(y), class: "gridline" });
    node("text", { x: L - 6, y: ty(y) + 4, "text-anchor": "end", class: "tick" }, y >= 100 ? y.toFixed(0) : y.toFixed(y < 10 ? 1 : 0));
  }
  node("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle", class: "axis-label" }, "Displacement (in)");
  node("text", { x: 14, y: (T + H - B) / 2, "text-anchor": "middle", class: "axis-label",
                 transform: `rotate(-90 14 ${(T + H - B) / 2})` }, "Force (lbf)");
  for (const s of series) {
    if (s.low && s.high) {
      const upper = s.x.map((x, i) => `${tx(x).toFixed(1)},${ty(s.high[i]).toFixed(1)}`);
      const lower = s.x.map((x, i) => `${tx(x).toFixed(1)},${ty(s.low[i]).toFixed(1)}`).reverse();
      node("polygon", { points: [...upper, ...lower].join(" "), class: `band ${s.cls}`, "clip-path": `url(#${clipId})` });
    }
  }
  for (const s of series) {
    node("polyline", { points: s.x.map((x, i) => `${tx(x).toFixed(1)},${ty(s.y[i]).toFixed(1)}`).join(" "),
                       class: `line ${s.cls}`, "clip-path": `url(#${clipId})` });
  }
  for (const m of markers) {
    node("line", { x1: tx(m.x), x2: tx(m.x), y1: T, y2: H - B, class: `marker ${m.cls || ""}` });
    node("text", { x: tx(m.x) + 4, y: T + 12, class: "tick" }, m.label);
  }
  return svg;
}

function curveSeries(curve, label, cls) {
  return { x: curve.displacement_in, y: curve.force_lbf, low: curve.force_low_lbf, high: curve.force_high_lbf, label, cls };
}

function curveCsv(curve, name) {
  return () => downloadCsv(`${name}_predicted_curve.csv`, curve.displacement_in.map((d, i) => ({
    displacement_in: d, force_lbf: curve.force_lbf[i], force_p10_lbf: curve.force_low_lbf[i], force_p90_lbf: curve.force_high_lbf[i] })));
}

function resultChart(result, compareTo, name) {
  if (!result.curve) return null;
  const series = [curveSeries(result.curve, "Predicted (band: 10th–90th percentile of trees)", "predicted")];
  if (compareTo && compareTo.curve) series.push({ ...curveSeries(compareTo.curve, "Baseline", "baseline"), low: null, high: null });
  const length = result.estimates.find((e) => e.name === "plateau_length_pct");
  const interval = Number.isFinite(result.curve.plateau_start_in) && Number.isFinite(result.curve.plateau_end_in);
  const markers = interval ? [
    { x: result.curve.plateau_start_in, label: "plateau start", cls: "onset" },
    { x: result.curve.plateau_end_in, label: "plateau end", cls: "onset" },
  ] : length && length.value_in !== undefined ? [{ x: length.value_in, label: "densification onset", cls: "onset" }] : [];
  return chartPanel(series, { markers, download: curveCsv(result.curve, name) });
}

// ---------- results ----------
function estimateCards(result, compareTo, name = "design") {
  const base = compareTo ? Object.fromEntries(compareTo.estimates.map((e) => [e.name, e])) : {};
  const cards = result.estimates.map((e) => {
    const inches = e.value_in !== undefined;
    const main = inches ? fmt(e.value_in, 3) : fmt(e.value, e.unit === "%" ? 1 : 2);
    const unit = inches ? "in" : e.unit;
    const spread = inches ? e.spread_in : e.spread;
    const children = [
      el("div", { class: "label", text: e.label }),
      el("div", { class: "value" }, main, " ", el("span", { class: "unit", text: unit })),
    ];
    if (inches) children.push(el("div", { class: "secondary", text: `${fmt(e.value, 1)} % of stroke` }));
    if (spread !== null && spread !== undefined) {
      children.push(el("div", { class: "spread", text: `Tree spread ± ${fmt(spread, inches ? 3 : 2)} ${unit}` }));
    }
    const ref = base[e.name];
    if (ref) {
      const delta = inches ? e.value_in - ref.value_in : e.value - ref.value;
      const sign = delta > 0 ? "+" : "";
      children.push(el("div", { class: `delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`,
        text: `${sign}${fmt(delta, inches ? 3 : 2)} ${unit} vs baseline` }));
    }
    return el("div", { class: "estimate" }, children);
  });
  const nodes = [el("div", { class: "estimates" }, cards)];
  const chart = resultChart(result, compareTo, name);
  if (chart) nodes.push(chart);
  if (result.out_of_range && result.out_of_range.length) {
    nodes.push(el("div", { class: "warnings" },
      el("strong", { text: "Outside the tested designs — treat as extrapolation:" }),
      el("ul", {}, result.out_of_range.slice(0, 8).map((f) =>
        el("li", { text: `${f.feature} = ${fmt(f.value, 4)} (trained ${fmt(f.low, 4)} to ${fmt(f.high, 4)})` }))),
      result.out_of_range.length > 8 ? el("div", { text: `…and ${result.out_of_range.length - 8} more.` }) : null));
  }
  if (result.tested_parameter_combination === false) {
    nodes.push(el("p", { class: "warnings", text: "Untested parameter combination. It is within the tested ranges, but this combination was not validated." }));
  }
  if (result.measured) {
    nodes.push(el("details", {}, el("summary", { text: "Measured geometry the model saw" }),
      el("table", { class: "metrics" }, Object.entries(result.measured).map(([k, v]) =>
        el("tr", {}, el("th", { text: k }), el("td", { text: fmt(v, 4) }))))));
  }
  return nodes;
}

function addHistory(label, result) {
  const row = { time: new Date().toLocaleTimeString(), label, model: state.model.slug, ...result.params };
  for (const e of result.estimates) {
    row[`${e.name}`] = Number(e.value.toFixed(4));
    if (e.value_in !== undefined) row.plateau_length_in = Number(e.value_in.toFixed(4));
  }
  row.out_of_range_features = (result.out_of_range || []).length;
  state.history.unshift(row);
  renderTable("history-table", state.history.slice(0, 50), ["time", "label", "plateau_length_in", "plateau_force_lbf",
    "energy_in_lbf", "apex_offset_in", "strut_width_lower_in", "strut_width_upper_in", "angle_lower_deg",
    "angle_upper_deg", "junction", "out_of_range_features"]);
}

function renderTable(id, rows, columns, rowClass) {
  const table = $(id);
  const caption = table.querySelector("caption");
  table.replaceChildren();
  if (caption) table.append(caption);
  if (!rows.length) return;
  table.append(el("thead", {}, el("tr", {}, columns.map((c) => el("th", { scope: "col", class: typeof rows[0][c] === "string" ? "text" : null, text: c })))));
  table.append(el("tbody", {}, rows.map((r) => el("tr", { class: rowClass ? rowClass(r) : null },
    columns.map((c) => el("td", { class: typeof r[c] === "string" ? "text" : null,
      text: typeof r[c] === "number" ? fmt(r[c], 4) : (r[c] ?? "") }))))));
}

// ---------- design tab ----------
async function estimateDesign(event) {
  event.preventDefault();
  let params;
  try { params = readParams(); } catch (error) { showError("form-error", error.message); return; }
  showError("form-error", "");
  const target = $("design-result");
  target.replaceChildren(el("span", { class: "result-empty", text: "Estimating…" }));
  try {
    const result = await api("/api/predict", { model: state.model.slug, params });
    state.lastDesign = result;
    if (result.outline) drawOutline("preview", result.outline);
    target.replaceChildren(...estimateCards(result, state.baseline && state.baseline.model === state.model.slug ? state.baseline.result : null));
    const reference = $("load-reference").selectedOptions[0];
    addHistory(reference && reference.value ? reference.textContent : "custom", result);
  } catch (error) {
    target.replaceChildren(el("span", { class: "error", text: error.message }));
  }
}

function setBaseline() {
  if (!state.lastDesign) { showError("form-error", "Estimate a design first, then set it as the baseline."); return; }
  state.baseline = { model: state.model.slug, result: state.lastDesign };
  $("design-result").replaceChildren(el("p", { class: "hint", text: "Baseline set. Change parameters and estimate to compare." }),
    ...estimateCards(state.lastDesign, null, "baseline"));
}

// ---------- upload tab ----------
async function uploadDxf() {
  const file = $("dxf-input").files[0];
  if (!file) return;
  showError("upload-error", "");
  $("upload-result").replaceChildren(el("span", { class: "result-empty", text: "Measuring and estimating…" }));
  if (file.size > 6 * 1024 * 1024) { showError("upload-error", "That file is over 6 MB."); return; }
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  try {
    const result = await api("/api/predict-dxf", { model: state.model.slug, filename: file.name, content_base64: btoa(binary) });
    drawOutline("upload-preview", result.outline);
    $("upload-result").replaceChildren(...estimateCards(result, null, file.name.replace(/\.dxf$/i, "")));
    const holder = $("upload-params");
    holder.replaceChildren();
    if (result.params) {
      holder.append(el("h3", { text: "Recovered chevron parameters" }),
        el("table", { class: "metrics" }, Object.entries(result.params).map(([k, v]) =>
          el("tr", {}, el("th", { text: k }), el("td", { text: typeof v === "number" ? fmt(v, 4) : v })))),
        el("p", { class: "hint", text: `Rebuilding from these parameters differs from the file by ${fmt(result.rebuild_mismatch_pct, 3)} % of its area.` }),
        el("button", { type: "button", onclick: () => { writeParams(result.params); $("tab-design").click(); } ,
          text: "Open in designer" }));
    }
    addHistory(file.name, { ...result, params: result.params || {} });
  } catch (error) {
    $("upload-result").replaceChildren();
    showError("upload-error", error.message);
  }
}

// ---------- batch tab ----------
async function runBatch() {
  showError("batch-error", "");
  const text = $("batch-text").value.trim();
  if (!text) { showError("batch-error", "Paste CSV text or open a CSV file first."); return; }
  try {
    const data = await api("/api/predict-batch", { model: state.model.slug, csv: text });
    state.batchRows = data.rows.map((r) => {
      const row = { line: r.line, name: r.name, status: r.status };
      if (r.status === "ok") {
        for (const e of r.estimates) {
          row[e.name] = Number(e.value.toFixed(4));
          if (e.value_in !== undefined) row.plateau_length_in = Number(e.value_in.toFixed(4));
          if (e.spread !== null) row[`${e.name}_spread`] = Number(e.spread.toFixed(4));
        }
        row.out_of_range_features = r.out_of_range.length;
        Object.assign(row, r.params);
      } else {
        row.error = r.error;
      }
      return row;
    });
    const columns = ["line", "name", "status", "plateau_length_in", "plateau_length_pct", "plateau_force_lbf",
      "energy_in_lbf", "out_of_range_features", "error"];
    renderTable("batch-table", state.batchRows, columns, (r) => (r.status === "error" ? "error-row" : null));
    $("export-batch").disabled = false;
  } catch (error) {
    showError("batch-error", error.message);
  }
}

// ---------- tested designs ----------
function referenceRows() {
  return state.references.map((r) => ({
    design_id: r.design_id, role: r.role,
    measured_plateau_length_in: Number(r.measured_plateau_length_in),
    measured_plateau_force_lbf: Number(r.measured_plateau_force_lbf),
    measured_energy_in_lbf: Number(r.measured_energy_in_lbf),
    apex_offset_in: Number(r.apex_offset_in), angle_lower_deg: Number(r.angle_lower_deg),
    angle_upper_deg: Number(r.angle_upper_deg), strut_width_lower_in: Number(r.strut_width_lower_in),
    strut_width_upper_in: Number(r.strut_width_upper_in), junction: r.junction,
  }));
}

function renderTested(rows) {
  const columns = Object.keys(rows[0] || {});
  renderTable("tested-table", rows, columns, (r) => `role-${String(r.role).replace(/\s+/g, "-")}`);
}

async function busy(buttonId, label, work) {
  const button = $(buttonId);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { await work(); } finally { button.disabled = false; button.textContent = original; }
}

async function compareTested() {
  if (state.references.length && state.references[0].oof_predicted_plateau_length_in !== undefined) {
    // Curve models trained on every design ship out-of-fold predictions; use those.
    renderTested(state.references.map((r) => ({
      design_id: r.design_id, role: "out-of-fold",
      measured_plateau_length_in: Number(r.measured_plateau_length_in),
      predicted_plateau_length_in: Number(r.oof_predicted_plateau_length_in),
      length_error_in: Number(r.oof_predicted_plateau_length_in) - Number(r.measured_plateau_length_in),
      measured_plateau_force_lbf: Number(r.measured_plateau_force_lbf),
      predicted_plateau_force_lbf: Number(r.oof_predicted_plateau_force_lbf),
      measured_energy_in_lbf: Number(r.measured_energy_in_lbf),
      predicted_energy_in_lbf: Number(r.oof_predicted_energy_in_lbf) })));
    return;
  }
  const names = state.parameters.map((p) => p.name);
  const csv = ["name," + names.join(","), ...state.references.map((r) => [r.design_id, ...names.map((n) => r[n])].join(","))].join("\n");
  try {
    const data = await api("/api/predict-batch", { model: state.model.slug, csv });
    const byName = Object.fromEntries(data.rows.map((r) => [r.name, r]));
    const rows = referenceRows().map((row) => {
      const result = byName[row.design_id];
      if (!result || result.status !== "ok") return { ...row, predicted_plateau_length_in: null, length_error_in: null };
      const est = Object.fromEntries(result.estimates.map((e) => [e.name, e]));
      const predicted = est.plateau_length_pct.value_in;
      return { design_id: row.design_id, role: row.role,
        measured_plateau_length_in: row.measured_plateau_length_in, predicted_plateau_length_in: predicted,
        length_error_in: predicted - row.measured_plateau_length_in,
        measured_plateau_force_lbf: row.measured_plateau_force_lbf, predicted_plateau_force_lbf: est.plateau_force_lbf.value,
        measured_energy_in_lbf: row.measured_energy_in_lbf, predicted_energy_in_lbf: est.energy_in_lbf.value };
    });
    renderTested(rows);
  } catch (error) {
    state.banner(error.message);
  }
}

// ---------- about ----------
function renderAbout(model) {
  const about = $("about");
  about.replaceChildren();
  const accuracy = model.accuracy || {};
  const cv = (accuracy.cross_validation || {}).metrics || [];
  const held = (accuracy.held_out || {}).metrics || [];
  const recurvedMetrics = accuracy.plateau_force_lbf ? el("table", { class: "metrics" },
    el("thead", {}, el("tr", {}, ["Target", "MAE", "R²", "Noise floor", "≈ resolvable"].map((c) => el("th", { text: c })))),
    el("tbody", {}, [
      ["Plateau force", accuracy.plateau_force_lbf, "lbf"],
      ["Plateau length", accuracy.plateau_length_in, "in"],
      ["Energy", accuracy.energy_in_lbf, "in·lbf"],
    ].map(([target, metric, unit]) => el("tr", {},
      el("td", { text: target }),
      el("td", { text: `${metric.mae.toFixed(unit === "lbf" ? 2 : 3)} ${unit}` }),
      el("td", { text: metric.r2.toFixed(3) }),
      el("td", { text: `${metric.noise_floor_mae} ${unit}` }),
      el("td", { text: `${metric.resolvable_difference_approx} ${unit}` }))))
  ) : null;
  about.append(el("h2", { text: model.name }), el("p", { text: model.description || "" }),
    el("div", { class: "about-grid" },
      el("div", {},
        el("h3", { text: "What it predicts" }),
        el("ul", {}, model.targets.map((t) => el("li", {}, el("strong", { text: `${t.label} (${t.unit}): ` }),
          (model.target_definitions || {})[t.name] || ""))),
        el("h3", { text: "Inputs" }),
        el("p", { text: model.input_kind === "recurved_doe"
          ? `Eight nominal DOE parameters. Family: ${model.family_label}. Target definition: ${model.target_definition_id}.`
          : `${model.feature_count} geometry features (${model.feature_set}) measured by PadML Studio. Family: ${model.family_label || model.design_family || "any"}. Estimator: ${model.estimator}, ${model.training_count} training designs.` })),
      el("div", {},
        el("h3", { text: "Accuracy" }),
        accuracy.method ? el("p", { class: "hint", text: accuracy.method }) : null,
        recurvedMetrics,
        cv.length ? el("p", { class: "hint", text: (accuracy.cross_validation || {}).method || "" }) : null,
        cv.length ? el("table", { class: "metrics" },
          el("tr", {}, ["Target", "MAE", "RMSE", "R²", "Plateau length MAE"].map((h) => el("th", { text: h }))),
          cv.map((m) => el("tr", {}, el("td", { text: m.target }), el("td", { text: fmt(m.mae, 3) }),
            el("td", { text: fmt(m.rmse, 3) }), el("td", { text: fmt(m.r2, 2) }),
            el("td", { text: m.mae_in !== undefined ? `${fmt(m.mae_in, 3)} in (max ${fmt(m.max_abs_in, 3)} in)` : "" })))) : null,
        (accuracy.cross_validation || {}).curve ? el("p", { text:
          `Whole-curve force error (median): ${fmt(accuracy.cross_validation.curve.plateau_force_median_relative_error * 100, 0)} % on the plateau, ` +
          `${fmt(accuracy.cross_validation.curve.densification_force_median_relative_error * 100, 0)} % during densification.` }) : null,
        held.length ? el("p", { class: "hint", text: `Held-out test designs: ${(accuracy.held_out.design_ids || []).join(", ")}` }) : null),
      el("div", {},
        el("h3", { text: "Caveats" }),
        el("ul", {}, (model.caveats || []).map((c) => el("li", { text: c }))),
        el("p", { class: "hint", text: `Published ${model.published_at || "?"}; condition ${model.condition_id || "?"}.` }))));
}

// ---------- model selection ----------
async function selectModel(slug) {
  state.model = state.models.find((m) => m.slug === slug);
  if (!state.model) return;
  const isDoe = state.model.input_kind === "recurved_doe";
  $("model-family").textContent = state.model.family_label ? state.model.family_label :
    (state.model.design_family ? `${state.model.design_family} only` : "");
  $("design-form-title").textContent = isDoe ? "Campaign 3 DOE parameters" : "Chevron parameters";
  $("design-form").querySelector(".hint").textContent = isDoe
    ? "Enter the 8 nominal DOE parameters. Values outside tested ranges are rejected. In-range combinations absent from the experiment are flagged."
    : "Left and right struts are mirrored. Angles are the leg's inner edge to the interface. Widths are each leg's mean horizontal width.";
  $("load-reference").parentElement.hidden = isDoe;
  $("preview").closest(".card").hidden = isDoe;
  $("tab-upload").hidden = isDoe;
  $("tab-batch").hidden = isDoe;
  $("tab-tested").hidden = isDoe;
  $("design-form").querySelector("#set-baseline").hidden = isDoe;
  $("design-form").querySelector("#reset-params").hidden = isDoe;
  $("session-card").hidden = isDoe;
  buildForm();
  renderAbout(state.model);
  try {
    state.references = (await api(`/api/models/${encodeURIComponent(slug)}/references`)).references;
  } catch { state.references = []; }
  const select = $("load-reference");
  select.replaceChildren(el("option", { value: "", text: "Choose…" }),
    ...state.references.map((r) => el("option", { value: r.design_id, text: `${r.design_id.replace("CHEVRON_SCREENING1_", "")} (${r.role})` })));
  renderTested(referenceRows());
  const block = $("tested-curve-block");
  $("tab-upload").hidden = isDoe;
  $("tab-batch").hidden = isDoe;
  $("tab-tested").hidden = isDoe;
  block.hidden = !state.model.has_curves;
  $("tested-curve").replaceChildren();
  if (state.model.has_curves) {
    $("tested-curve-select").replaceChildren(el("option", { value: "", text: "Choose a tested design…" }),
      ...state.references.map((r) => el("option", { value: r.design_id, text: r.design_id.replace("CHEVRON_SCREENING1_", "") })));
  }
}

async function loadCampaign3Report() {
  const target = $("campaign3-report");
  if (target.dataset.loaded) return;
  try {
    const report = await api("/api/reports/campaign3");
    target.replaceChildren(el("h2", { text: report.title }));
    for (const section of report.sections) {
      target.append(el("h3", { text: section.title }));
      for (const paragraph of section.paragraphs || []) target.append(el("p", { text: paragraph }));
      if (section.table) {
        const table = el("table", { class: "metrics" },
          el("thead", {}, el("tr", {}, section.table.columns.map((c) => el("th", { text: c })))),
          el("tbody", {}, section.table.rows.map((row) => el("tr", {}, row.map((cell) => el("td", { text: String(cell) }))))));
        target.append(el("div", { class: "table-wrap" }, table));
      }
      for (const image of section.images || []) target.append(el("figure", {},
        el("img", { src: image.data_url, alt: image.alt, loading: "lazy", class: "report-figure" }),
        el("figcaption", { text: image.caption })));
    }
    target.dataset.loaded = "true";
  } catch (error) {
    // 503 means the server runs without a password; the report is never served unauthenticated.
    const message = error.status === 503
      ? "Campaign 3 data needs the server to run with a password. Stop the server, set PADML_PREDICTOR_PASSWORD (PowerShell: $env:PADML_PREDICTOR_PASSWORD = '<passphrase>'), restart it, then reopen this tab."
      : error.message;
    target.replaceChildren(el("p", { class: "error", text: message }));
  }
}

async function showTestedCurve(designId) {
  const target = $("tested-curve");
  target.replaceChildren();
  if (!designId) return;
  try {
    const data = await api(`/api/models/${encodeURIComponent(state.model.slug)}/curves/${encodeURIComponent(designId)}`);
    const series = [];
    if (data.out_of_fold) series.push(curveSeries(data.out_of_fold, "Predicted without this design (out-of-fold)", "predicted"));
    series.push({ x: data.measured.displacement_in, y: data.measured.force_lbf, label: "Measured (lab)", cls: "measured" });
    target.append(chartPanel(series, { title: designId.replace("CHEVRON_SCREENING1_", "") }));
  } catch (error) {
    target.append(el("p", { class: "error", text: error.message }));
  }
}

async function init() {
  setupTabs();
  const banner = $("banner");
  state.banner = (message) => { banner.textContent = message; banner.hidden = !message; };
  let data;
  try { data = await api("/api/models"); }
  catch (error) { state.banner(`Could not reach the predictor server: ${error.message}`); return; }
  state.models = data.models;
  state.parameters = data.parameters;
  const problems = Object.entries(data.problems || {});
  if (!state.models.length) {
    state.banner("No models are registered. Publish one with python -m padml_predict.publish (see README).");
  } else if (problems.length) {
    state.banner(`Some model folders were skipped: ${problems.map(([k, v]) => `${k} (${v})`).join("; ")}`);
  }
  $("model-select").replaceChildren(...state.models.map((m) => el("option", { value: m.slug, text: m.name })));
  $("model-select").addEventListener("change", (e) => selectModel(e.target.value));
  buildForm();
  $("design-form").addEventListener("submit", estimateDesign);
  $("set-baseline").addEventListener("click", setBaseline);
  $("reset-params").addEventListener("click", () => {
    writeParams(Object.fromEntries(state.parameters.map((p) => [p.name, p.default])));
    $("load-reference").value = "";
  });
  $("load-reference").addEventListener("change", (e) => {
    const ref = state.references.find((r) => r.design_id === e.target.value);
    if (ref) writeParams(ref);
  });
  $("design-form").addEventListener("change", (e) => {
    if (e.target.id !== "load-reference" && e.target.tagName === "SELECT") $("load-reference").value = "";
  });
  $("export-history").addEventListener("click", () => downloadCsv("padml_estimates.csv", state.history));
  $("clear-history").addEventListener("click", () => { state.history = []; renderTable("history-table", [], []); });
  $("dxf-input").addEventListener("change", uploadDxf);
  $("batch-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) $("batch-text").value = await file.text();
  });
  $("download-template").addEventListener("click", downloadTemplate);
  $("run-batch").addEventListener("click", () => busy("run-batch", "Estimating…", runBatch));
  $("export-batch").addEventListener("click", () => downloadCsv("padml_batch_estimates.csv", state.batchRows));
  $("tested-curve-select").addEventListener("change", (e) => showTestedCurve(e.target.value));
  $("tab-campaign3").addEventListener("click", loadCampaign3Report);
  $("predict-tested").addEventListener("click", () => busy("predict-tested", "Comparing… (about 20 s)", compareTested));
  if (state.models.length) await selectModel(state.models[0].slug);
  schedulePreview();
}

document.addEventListener("DOMContentLoaded", init);
