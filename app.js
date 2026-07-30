const ANCHORS = [1, 3, 7, 14, 30, 60, 90, 120, 150, 180];
const $ = (id) => document.getElementById(id);
const SITE_BASE = new URL("./", document.baseURI);
const siteUrl = (value) => {
  if (!value || /^(https?:)?\/\//.test(value)) return value;
  return new URL(String(value).replace(/^\/+/, ""), SITE_BASE).toString();
};
const MAP_FONT = "\"Inter\", \"Pretendard\", \"Noto Sans KR\", system-ui, -apple-system, sans-serif";
const state = {
  snapshot: null,
  forecastManifest: null,
  routeManifest: null,
  historyManifest: null,
  iceClass: "PC5",
  destination: "jang_bogo",
  stationCatalog: null,
  stationCountry: "all",
  stationSeason: "all",
  currentRoute: null,
  fieldCache: new Map(),
  renderToken: 0,
  lead: 60,
  selectedDate: null,
  month: null,
  lastMap: null,
  mapView: { zoom: 1, panX: 0, panY: 0, dragging: false, pointerId: null, lastX: 0, lastY: 0 },
};

function parseDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function monthValue(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function forecastDateBounds() {
  const issue = parseDate(state.snapshot?.issue_date);
  if (!issue) return [null, null];
  return [addDays(issue, 1), addDays(issue, Number(state.snapshot?.forecast?.horizon_days || 180))];
}

function leadSource(lead) {
  const available = state.forecastManifest?.anchors || state.snapshot?.forecast?.available_anchors || [];
  if (available.includes(lead)) return "trained_anchor";
  if (
    available.length > 1
    && state.snapshot?.forecast?.allow_preview_interpolation
    && lead >= Math.min(...available)
    && lead <= Math.max(...available)
  ) {
    return "interpolated";
  }
  return "unavailable";
}

function nearestAnchors(lead) {
  const values = (state.forecastManifest?.anchors || state.snapshot?.forecast?.available_anchors || [])
    .slice().sort((a, b) => a - b);
  const lower = values.filter((x) => x <= lead).pop();
  const upper = values.find((x) => x >= lead);
  return [lower, upper];
}

function routeForLead(lead) {
  return state.routeManifest?.routes?.[String(lead)] || null;
}

function routeForDate(dateStr) {
  return state.routeManifest?.history?.[dateStr] || null;
}

async function loadHistoryField(dateStr) {
  const cacheKey = `history:${dateStr}`;
  if (state.fieldCache.has(cacheKey)) return state.fieldCache.get(cacheKey);
  const descriptor = state.historyManifest?.dates?.[dateStr];
  if (!descriptor?.url) throw new Error(`no observed SIC field registered for ${dateStr}`);
  const response = await fetch(siteUrl(descriptor.url), { cache: "no-store" });
  if (!response.ok) throw new Error(`${descriptor.url} status ${response.status}`);
  const values = new Uint8Array(await response.arrayBuffer());
  const expected = Number(state.historyManifest.width) * Number(state.historyManifest.height);
  if (values.length !== expected) {
    throw new Error(`${dateStr} field size ${values.length}; expected ${expected}`);
  }
  const field = { values, width: Number(state.historyManifest.width), height: Number(state.historyManifest.height), descriptor };
  state.fieldCache.set(cacheKey, field);
  return field;
}

function fieldForDate(dateStr) {
  return loadHistoryField(dateStr);
}

function availableIceClasses() {
  const route = state.snapshot?.route || {};
  return route.available_classes?.length
    ? route.available_classes
    : state.routeManifest?.vessel_class ? [state.routeManifest.vessel_class] : [];
}

function availableDestinations() {
  const route = state.snapshot?.route || {};
  return route.available_destinations?.length
    ? route.available_destinations
    : state.routeManifest?.destination_id ? [state.routeManifest.destination_id] : [];
}

function destinationInfo(destinationId = state.destination) {
  return state.snapshot?.route?.destinations?.[destinationId]
    || (state.routeManifest?.destination_id === destinationId
      ? state.routeManifest.destination : null)
    || { id: destinationId, name: destinationId.replaceAll("_", " "), operator: "" };
}

function routeManifestUrl(destinationId, iceClass) {
  const route = state.snapshot?.route || {};
  return route.destination_manifests?.[destinationId]?.[iceClass]
    || (destinationId === (route.default_destination || "jang_bogo")
      ? route.class_manifests?.[iceClass] : null)
    || (destinationId === (route.default_destination || "jang_bogo")
        && iceClass === (route.default_class || route.vessel_class)
      ? route.route_manifest_url : null);
}

function filteredDestinations() {
  return availableDestinations().filter((destinationId) => (
    state.stationCountry === "all"
    || destinationInfo(destinationId).operator === state.stationCountry
  ));
}

function hydrateDestinationControl() {
  const select = $("destination-select");
  const destinations = filteredDestinations();
  select.innerHTML = "";
  destinations.forEach((destinationId) => {
    const info = destinationInfo(destinationId);
    const option = document.createElement("option");
    option.value = destinationId;
    option.textContent = info.name || destinationId;
    select.appendChild(option);
  });
  if (destinations.includes(state.destination)) select.value = state.destination;
  select.disabled = destinations.length < 2;
  const info = destinationInfo();
  const destinationName = info.name || "selected station";
  const stationName = /\bstation$/i.test(destinationName) ? destinationName : `${destinationName} Station`;
  $("route-title").textContent = `Route to ${stationName}`;
  $("destination-operator").textContent = `${info.operator || "Antarctic facility"} · offshore approach corridor`;
  $("route-goal-label").textContent = destinationName;
}

function hydrateIceClassControl() {
  const select = $("ice-class-select");
  const classes = availableIceClasses();
  select.innerHTML = "";
  classes.forEach((iceClass) => {
    const option = document.createElement("option");
    option.value = iceClass;
    option.textContent = iceClass === "PC5" ? "PC5 · Araon default" : iceClass;
    select.appendChild(option);
  });
  if (classes.includes(state.iceClass)) select.value = state.iceClass;
  select.disabled = classes.length < 2;
  $("route-decision-kicker").textContent = `${state.iceClass} DECISION SUPPORT`;
  $("route-pipeline-label").textContent = `${state.iceClass} route planning`;
  $("route-calendar-legend").innerHTML = `<i class="dot route-go"></i>${state.iceClass} VOYAGE TIME`;
}

async function loadRouteManifest(destinationId, iceClass) {
  const destinations = availableDestinations();
  const classes = availableIceClasses();
  if (!destinations.includes(destinationId) || !classes.includes(iceClass)) return;
  const url = routeManifestUrl(destinationId, iceClass);
  if (!url) return;
  const classSelect = $("ice-class-select");
  const destinationSelect = $("destination-select");
  classSelect.disabled = true;
  destinationSelect.disabled = true;
  try {
    const response = await fetch(siteUrl(url), { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} status ${response.status}`);
    const manifest = await response.json();
    if (manifest.issue_date !== state.snapshot.issue_date
        || manifest.vessel_class !== iceClass
        || (manifest.destination_id || destinationId) !== destinationId
        || Object.keys(manifest.routes || {}).length !== 180) {
      throw new Error("destination and ship-class route manifest contract mismatch");
    }
    state.destination = destinationId;
    state.iceClass = iceClass;
    state.routeManifest = manifest;
    hydrateDestinationControl();
    hydrateIceClassControl();
    updateSelection();
  } catch (error) {
    console.error(error);
    destinationSelect.value = state.destination;
    classSelect.value = state.iceClass;
  } finally {
    destinationSelect.disabled = filteredDestinations().length < 2;
    classSelect.disabled = availableIceClasses().length < 2;
  }
}

async function selectIceClass(iceClass) {
  return loadRouteManifest(state.destination, iceClass);
}

async function selectDestination(destinationId) {
  return loadRouteManifest(destinationId, state.iceClass);
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "short"
  }).format(date);
}

function updateSelection() {
  const issue = parseDate(state.snapshot?.issue_date);
  if (!issue) return;
  const horizon = Number(state.snapshot?.forecast?.horizon_days || 180);
  const target = addDays(issue, state.lead);
  state.selectedDate = target;
  state.month = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1));

  const isHistorical = state.lead < 1;
  $("lead-range").value = state.lead;
  $("lead-output").textContent = isHistorical
    ? `${isoDate(target)} (observed)`
    : `${state.lead} ${state.lead === 1 ? "day" : "days"}`;
  const targetInput = $("target-date-input");
  targetInput.value = isoDate(target);
  $("target-date-prev").disabled = targetInput.disabled || state.lead <= 1;
  $("target-date-next").disabled = targetInput.disabled || state.lead >= horizon;
  let source;
  if (isHistorical) {
    state.currentRoute = routeForDate(isoDate(target));
    source = state.currentRoute ? "observed" : "unavailable";
  } else {
    source = leadSource(state.lead);
    state.currentRoute = routeForLead(state.lead);
  }
  document.querySelectorAll(".anchor-row button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.lead) === state.lead);
  });
  updateDecision(source);
  renderMap(source, isHistorical ? isoDate(target) : null);
  renderCalendar();
}

function routeDecisionCopy(route) {
  if (route.status === "no_path") {
    return `No continuous ${state.iceClass} route satisfies the strict POLARIS threshold for this date.`;
  }
  if (route.recommendation === "go") {
    return `A continuous ${state.iceClass} route is available under the strict POLARIS threshold.`;
  }
  return "A route was found, but it is held under the current voyage-duration rule.";
}

function updateDecision(source) {
  const icon = $("decision-icon");
  icon.className = "decision-icon pending";
  icon.textContent = "?";
  icon.setAttribute("aria-label", "Awaiting route status");
  $("eta-value").textContent = "—";
  $("route-distance-value").textContent = "—";
  $("rio-value").textContent = "—";
    icon.setAttribute("aria-label", "Forecast unavailable");
  if (source === "unavailable" || !state.snapshot?.forecast?.fields_ready) {
    icon.textContent = "?";
    $("decision-label").textContent = "Awaiting forecast";
    $("decision-copy").textContent = "Route planning is disabled until a validated forecast field is available.";
    return;
  }
    icon.setAttribute("aria-label", "Route calculation pending");
  const route = state.currentRoute;
  if (!route) {
    icon.textContent = "·";
    $("decision-label").textContent = "Awaiting route calculation";
    $("decision-copy").textContent = `The SIC forecast is ready, but no ${state.iceClass} route is available for this date.`;
    return;
  }
  if (route.status === "no_path") {
    icon.className = "decision-icon hold";
    icon.textContent = "";
    icon.setAttribute("aria-label", "Hold: no continuous route");
    $("decision-label").textContent = "No continuous route · Hold";
    $("decision-copy").textContent = routeDecisionCopy(route);
    return;
  }
  const go = route.recommendation === "go";
  icon.className = `decision-icon ${go ? "go" : "hold"}`;
  icon.textContent = "";
  icon.setAttribute("aria-label", go ? "Go" : "Hold");
  $("decision-label").textContent = go ? "Departure candidate" : "Extended route · Hold";
  const clamp = route.horizon_clamped ? " Conditions beyond L+180 use the final available forecast field." : "";
  $("decision-copy").textContent = `${routeDecisionCopy(route)}${clamp}`;
  $("eta-value").textContent = `${Number(route.eta_hours).toFixed(1)} h · ${Number(route.eta_days).toFixed(2)} d`;
  $("route-distance-value").textContent = `${Number(route.route_length_km).toLocaleString("en-GB")} km`;
  $("rio-value").textContent = Number.isFinite(route.min_rio) ? Number(route.min_rio).toFixed(1) : "—";
}
async function loadAnchorField(lead) {
  if (state.fieldCache.has(lead)) return state.fieldCache.get(lead);
  const manifest = state.forecastManifest;
  const descriptor = manifest?.fields?.[String(lead)];
  if (!descriptor?.url) throw new Error(`L+${lead} forecast field is not registered`);
  const response = await fetch(siteUrl(descriptor.url), { cache: "no-store" });
  if (!response.ok) throw new Error(`${descriptor.url} status ${response.status}`);
  const values = new Uint8Array(await response.arrayBuffer());
  const expected = Number(manifest.width) * Number(manifest.height);
  if (values.length !== expected) {
    throw new Error(`L+${lead} field size ${values.length}; expected ${expected}`);
  }
  const field = { values, width: Number(manifest.width), height: Number(manifest.height), descriptor };
  state.fieldCache.set(lead, field);
  return field;
}

async function fieldForLead(lead, source) {
  if (source === "trained_anchor") return loadAnchorField(lead);
  if (source !== "interpolated") return null;
  const [lower, upper] = nearestAnchors(lead);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  if (lower === upper) return loadAnchorField(lower);
  const [a, b] = await Promise.all([loadAnchorField(lower), loadAnchorField(upper)]);
  const weight = (lead - lower) / (upper - lower);
  const values = new Uint8Array(a.values.length);
  for (let index = 0; index < values.length; index++) {
    if (a.values[index] === 255 || b.values[index] === 255) {
      values[index] = 255;
    } else {
      values[index] = Math.round(a.values[index] * (1 - weight) + b.values[index] * weight);
    }
  }
  return {
    values, width: a.width, height: a.height,
    descriptor: { lower, upper, weight, target_date: isoDate(addDays(parseDate(state.snapshot.issue_date), lead)) },
  };
}

function sicColor(value, alpha = 255) {
  if (value === 255 || value < 0) return [4, 18, 23, 255];
  const t = Math.max(0, Math.min(1, value / 100));
  return [
    Math.round(8 + 225 * Math.pow(t, 1.5)),
    Math.round(41 + 207 * t),
    Math.round(54 + 188 * t),
    alpha,
  ];
}


const rasterCache = new WeakMap();

function rasterForField(field, source) {
  if (rasterCache.has(field)) return rasterCache.get(field);
  const raster = document.createElement("canvas");
  raster.width = field.width;
  raster.height = field.height;
  const rasterContext = raster.getContext("2d");
  const image = rasterContext.createImageData(field.width, field.height);
  const alpha = source === "unavailable" ? 150 : 255;
  for (let index = 0; index < field.values.length; index++) {
    const [r, g, b, a] = sicColor(field.values[index], alpha);
    const offset = index * 4;
    image.data[offset] = r;
    image.data[offset + 1] = g;
    image.data[offset + 2] = b;
    image.data[offset + 3] = a;
  }
  rasterContext.putImageData(image, 0, 0);
  rasterCache.set(field, raster);
  return raster;
}

function mapSurface() {
  const canvas = $("ice-map");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const backingWidth = Math.round(width * pixelRatio);
  const backingHeight = Math.round(height * pixelRatio);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { canvas, ctx, width, height, pixelRatio };
}

function mapGeometry(field, includePan = true) {
  const { width, height } = mapSurface();
  const baseScale = Math.min(
    (width - 100) / field.width,
    (height - 90) / field.height,
  );
  const scale = baseScale * state.mapView.zoom;
  const drawWidth = field.width * scale;
  const drawHeight = field.height * scale;
  return {
    drawWidth,
    drawHeight,
    ox: (width - drawWidth) / 2 + (includePan ? state.mapView.panX : 0),
    oy: (height - drawHeight) / 2 + (includePan ? state.mapView.panY : 0),
  };
}

function clampMapPan(field) {
  if (state.mapView.zoom <= 1) {
    state.mapView.panX = 0;
    state.mapView.panY = 0;
    return;
  }
  const { width, height } = mapSurface();
  const geometry = mapGeometry(field, false);
  const margin = 55;
  const minX = margin - (geometry.ox + geometry.drawWidth);
  const maxX = width - margin - geometry.ox;
  const minY = margin - (geometry.oy + geometry.drawHeight);
  const maxY = height - margin - geometry.oy;
  state.mapView.panX = Math.max(minX, Math.min(maxX, state.mapView.panX));
  state.mapView.panY = Math.max(minY, Math.min(maxY, state.mapView.panY));
}

function updateZoomUi() {
  $("map-zoom").value = state.mapView.zoom.toFixed(1);
  $("map-zoom-output").textContent = `${Math.round(state.mapView.zoom * 100)}%`;
}

function redrawLastMap() {
  if (!state.lastMap) return;
  drawField(state.lastMap.field, state.lastMap.label, state.lastMap.source, false);
}

function setMapZoom(nextZoom, focalPoint = null) {
  const last = state.lastMap;
  const oldZoom = state.mapView.zoom;
  const next = Math.max(1, Math.min(4, Number(nextZoom)));
  if (!last || next === oldZoom) {
    state.mapView.zoom = next;
    updateZoomUi();
    return;
  }
  const oldGeometry = mapGeometry(last.field);
  const surface = mapSurface();
  const focus = focalPoint || { x: surface.width / 2, y: surface.height / 2 };
  const dataX = (focus.x - oldGeometry.ox) / oldGeometry.drawWidth;
  const dataY = (focus.y - oldGeometry.oy) / oldGeometry.drawHeight;
  state.mapView.zoom = next;
  const nextGeometry = mapGeometry(last.field, false);
  state.mapView.panX = focus.x - nextGeometry.ox - dataX * nextGeometry.drawWidth;
  state.mapView.panY = focus.y - nextGeometry.oy - dataY * nextGeometry.drawHeight;
  clampMapPan(last.field);
  updateZoomUi();
  redrawLastMap();
}

function focusStation(key) {
  if (key === "all") {
    state.mapView.zoom = 1;
    state.mapView.panX = 0;
    state.mapView.panY = 0;
    updateZoomUi();
    redrawLastMap();
    return;
  }
  const station = state.routeManifest?.stations?.[key];
  if (!station?.normalized || !state.lastMap) return;
  state.mapView.zoom = 3;
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  const geometry = mapGeometry(state.lastMap.field, false);
  const surface = mapSurface();
  state.mapView.panX = surface.width / 2 - (geometry.ox + station.normalized[0] * geometry.drawWidth);
  state.mapView.panY = surface.height / 2 - (geometry.oy + station.normalized[1] * geometry.drawHeight);
  clampMapPan(state.lastMap.field);
  updateZoomUi();
  redrawLastMap();
}

function selectedCatalogStations() {
  const stations = state.stationCatalog?.stations || [];
  return stations.filter((station) => (
    (state.stationCountry === "all" || station.operator === state.stationCountry)
    && (state.stationSeason === "all" || station.seasonality === state.stationSeason)
  ));
}

function hydrateStationControls() {
  const country = $("station-country");
  if (state.stationCatalog && country.options.length === 1) {
    const routeOperators = [...new Set(
      availableDestinations().map((destinationId) => destinationInfo(destinationId).operator)
    )].filter(Boolean).sort();
    routeOperators.forEach((operator) => {
      const option = document.createElement("option");
      option.value = operator;
      option.textContent = operator;
      country.appendChild(option);
    });
  }
}

function focusCatalogSelection() {
  const stations = selectedCatalogStations();
  if (!stations.length || !state.lastMap) {
    redrawLastMap();
    return;
  }
  if (state.stationCountry === "all") {
    redrawLastMap();
    return;
  }
  const xs = stations.map((station) => station.normalized[0]);
  const ys = stations.map((station) => station.normalized[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  state.mapView.zoom = Math.min(4, Math.max(1.4, 0.72 / Math.max(span, 0.18)));
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  const geometry = mapGeometry(state.lastMap.field, false);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const surface = mapSurface();
  state.mapView.panX = surface.width / 2 - (geometry.ox + centerX * geometry.drawWidth);
  state.mapView.panY = surface.height / 2 - (geometry.oy + centerY * geometry.drawHeight);
  clampMapPan(state.lastMap.field);
  updateZoomUi();
  redrawLastMap();
}

function boxesOverlap(a, b, padding = 4) {
  return !(
    a.right + padding < b.left
    || a.left > b.right + padding
    || a.bottom + padding < b.top
    || a.top > b.bottom + padding
  );
}

function drawCollisionSafeLabel(ctx, text, px, py, occupiedLabels, options = {}) {
  const {
    font = `600 11px ${MAP_FONT}`,
    fill = "rgba(242,249,249,.96)",
    stroke = "rgba(3,12,16,.92)",
    lineWidth = 3,
  } = options;
  const surface = mapSurface();
  const fontSize = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] || 11);
  const gap = fontSize < 12 ? 8 : 10;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const width = ctx.measureText(text).width;
  const candidates = [
    { x: px + gap, y: py - 7, align: "left" },
    { x: px - gap, y: py - 7, align: "right" },
    { x: px + gap, y: py + fontSize + 7, align: "left" },
    { x: px - gap, y: py + fontSize + 7, align: "right" },
    { x: px, y: py - 11, align: "center" },
    { x: px, y: py + fontSize + 11, align: "center" },
  ];
  const placement = candidates.find((candidate) => {
    const left = candidate.align === "left"
      ? candidate.x
      : candidate.align === "right" ? candidate.x - width : candidate.x - width / 2;
    const box = {
      left,
      right: left + width,
      top: candidate.y - fontSize - 2,
      bottom: candidate.y + 3,
    };
    candidate.box = box;
    return box.left >= 6
      && box.right <= surface.width - 6
      && box.top >= 6
      && box.bottom <= surface.height - 6
      && !occupiedLabels.some((other) => boxesOverlap(box, other));
  });
  if (!placement) {
    ctx.restore();
    return false;
  }

  occupiedLabels.push(placement.box);
  ctx.textAlign = placement.align;
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.strokeText(text, placement.x, placement.y);
  ctx.fillStyle = fill;
  ctx.fillText(text, placement.x, placement.y);
  ctx.restore();
  return true;
}

function drawCatalogStations(ctx, geometry, occupiedLabels, mode = "all") {
  const stations = selectedCatalogStations();
  const surface = mapSurface();
  const forceLabels = state.stationCountry !== "all";
  stations.forEach((station) => {
    const px = geometry.ox + station.normalized[0] * geometry.drawWidth;
    const py = geometry.oy + station.normalized[1] * geometry.drawHeight;
    if (px < -20 || px > surface.width + 20 || py < -20 || py > surface.height + 20) return;
    const closed = station.status !== "Open";
    const color = closed ? "#718087" : station.seasonality === "Year-Round" ? "#70c8ff" : "#f68acb";
    if (mode !== "labels") {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(3,12,16,.94)";
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = closed ? 0.72 : 0.94;
      ctx.beginPath();
      ctx.arc(px, py, forceLabels ? 3.2 : 2.4, 0, Math.PI * 2);
      if (closed) ctx.stroke(); else { ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }

    const showLabel = forceLabels || state.mapView.zoom >= 3.15
      || (state.mapView.zoom >= 2.45 && station.seasonality === "Year-Round");
    if (mode === "points" || !showLabel || station.operator === "Republic of Korea") return;
    drawCollisionSafeLabel(ctx, station.name, px, py, occupiedLabels, {
      fill: closed ? "rgba(166,178,181,.86)" : "rgba(242,249,249,.96)",
    });
  });
}

function drawField(field, label, source, remember = true) {
  const { ctx, width, height } = mapSurface();
  ctx.clearRect(0, 0, width, height);
  if (!field?.values?.length || !field.width || !field.height) {
    $("map-fallback").classList.remove("hidden");
    return;
  }
  $("map-fallback").classList.add("hidden");
  if (remember) state.lastMap = { field, label, source };

  const raster = rasterForField(field, source);
  clampMapPan(field);
  const { drawWidth, drawHeight, ox, oy } = mapGeometry(field);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(raster, ox, oy, drawWidth, drawHeight);

  ctx.strokeStyle = "rgba(165,224,220,.13)";
  ctx.lineWidth = 1;
  const cx = ox + drawWidth / 2;
  const cy = oy + drawHeight / 2;
  const radius = Math.min(drawWidth, drawHeight) / 2;
  for (const fraction of [.25, .5, .75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let angle = 0; angle < 360; angle += 30) {
    const radians = angle * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(radians) * radius, cy + Math.sin(radians) * radius);
    ctx.stroke();
  }

  const occupiedLabels = [
    { left: 10, right: Math.min(width - 10, 235), top: height - 35, bottom: height - 7 },
  ];
  const stationGeometry = { drawWidth, drawHeight, ox, oy };
  drawCatalogStations(ctx, stationGeometry, occupiedLabels, "points");

  const route = state.currentRoute;
  const routeManifest = state.routeManifest;
  if (route?.path?.length) {
    ctx.save();
    ctx.strokeStyle = route.recommendation === "go" ? "#ff786f" : "#f0b86c";
    ctx.lineWidth = 3.1;
    ctx.shadowColor = "rgba(0,0,0,.72)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    route.path.forEach(([x, y], index) => {
      const px = ox + x * drawWidth;
      const py = oy + y * drawHeight;
      index ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }
  if (routeManifest?.start?.normalized) {
    const drawPoint = (point, color, text) => {
      const px = ox + point[0] * drawWidth;
      const py = oy + point[1] * drawHeight;
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(3,12,16,.92)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      drawCollisionSafeLabel(ctx, text, px, py, occupiedLabels, {
        font: `700 12px ${MAP_FONT}`,
        fill: "rgba(244,250,250,.97)",
        stroke: "rgba(3,12,16,.95)",
        lineWidth: 3.5,
      });
    };
    drawPoint(routeManifest.start.normalized, "#7ef0a8", "START");
    const stations = routeManifest.stations || {
      jang_bogo: { normalized: routeManifest.goal?.normalized, label: "JANG BOGO", route_goal: true },
    };
    Object.values(stations).forEach((station) => {
      if (!station?.normalized) return;
      const routeGoal = Boolean(station.route_goal);
      drawPoint(
        station.normalized,
        routeGoal ? "#ffd166" : "#70c8ff",
        station.name || station.label || "Station",
      );
    });
  }
  drawCatalogStations(ctx, stationGeometry, occupiedLabels, "labels");

  ctx.fillStyle = "rgba(166,182,185,.9)";
  ctx.font = `500 10px ${MAP_FONT}`;
  ctx.fillText(`${field.width}×${field.height} · SIC 0–100%`, 18, height - 18);
}

function observationField() {
  const grid = state.snapshot?.map_preview;
  if (!grid?.values?.length) return null;
  const values = new Uint8Array(grid.values.length);
  grid.values.forEach((value, index) => { values[index] = value < 0 ? 255 : value; });
  return { values, width: grid.width, height: grid.height };
}

async function renderMap(source, historicalDate = null) {
  const token = ++state.renderToken;
  if (source === "unavailable" || (!historicalDate && !state.forecastManifest)) {
    drawField(
      observationField(),
      `${state.snapshot?.map_preview?.label || "Latest SIC observation"} · OBSERVATION ONLY`,
      "unavailable",
    );
    return;
  }
  const { ctx, width, height } = mapSurface();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(141,162,166,.85)";
  ctx.font = `600 13px ${MAP_FONT}`;
  const target = historicalDate || isoDate(addDays(parseDate(state.snapshot.issue_date), state.lead));
  ctx.fillText(
    `Loading ${historicalDate ? "observed sea ice" : "sea-ice forecast"} for ${target}…`, 18, 25);
  try {
    const field = historicalDate ? await fieldForDate(historicalDate) : await fieldForLead(state.lead, source);
    if (token !== state.renderToken) return;
    drawField(field, `${historicalDate ? "Observed sea ice" : "Sea-ice forecast"} for ${target}`, source);
  } catch (error) {
    if (token !== state.renderToken) return;
    console.error(error);
    drawField(observationField(), `${historicalDate ? "Observed field" : "Forecast"} load failed · showing observation only`, "unavailable");
  }
}
function renderCalendar() {
  if (!state.month || !state.snapshot) return;
  const grid = $("calendar-grid");
  grid.innerHTML = "";
  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", year: "numeric", month: "long"
  }).format(state.month);
  $("calendar-title").textContent = `${state.iceClass} · ${destinationInfo().name} · ${monthLabel}`;
  $("calendar-month-input").value = monthValue(state.month);
  const issueDate = parseDate(state.snapshot.issue_date);
  const [, maxTarget] = forecastDateBounds();
  const currentMonth = Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), 1);
  const issueMonth = Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), 1);
  const maxMonth = Date.UTC(maxTarget.getUTCFullYear(), maxTarget.getUTCMonth(), 1);
  $("prev-month").disabled = currentMonth <= issueMonth;
  $("next-month").disabled = currentMonth >= maxMonth;

  const year = state.month.getUTCFullYear();
  const month = state.month.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const startOffset = (first.getUTCDay() + 6) % 7;
  const start = addDays(first, -startOffset);
  const issue = parseDate(state.snapshot.issue_date);

  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    const lead = Math.round((date - issue) / 86400000);
    const isForecast = lead >= 1 && lead <= 180;
    const isHistory = !isForecast && Boolean(routeForDate(isoDate(date)));
    const source = isForecast ? leadSource(lead) : isHistory ? "observed" : "unavailable";
    const route = isForecast ? routeForLead(lead) : isHistory ? routeForDate(isoDate(date)) : null;
    const routeClass = route?.recommendation === "go" ? "route-go" : route ? "route-hold" : "";
    const routeLabel = !route ? "—" : route.status === "no_path"
      ? "NO PATH" : `${Number(route.eta_days).toFixed(1)}d`;
    const routeDetail = !route ? "Route unavailable" : route.status === "no_path"
      ? `${state.iceClass}: no continuous route` :
        `${state.iceClass}: ${Number(route.eta_days).toFixed(2)} days · ${route.recommendation.toUpperCase()}`
          + (isHistory ? " · observed" : "");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `day-cell ${source} ${routeClass}${date.getUTCMonth() !== month ? " outside" : ""}${isoDate(date) === isoDate(state.selectedDate) ? " selected" : ""}`;
    button.title = `${isoDate(date)} · ${routeDetail}`;
    button.setAttribute("aria-label", `${isoDate(date)} · ${routeDetail}`);
    button.innerHTML = `
      <span class="date">${date.getUTCDate()}</span>
      <span class="route-state">${routeLabel}</span>`;
    button.disabled = !isForecast && !isHistory;
    button.addEventListener("click", () => {
      state.lead = lead;
      updateSelection();
    });
    grid.appendChild(button);
  }
}

function setPipeline(dotId, textId, stage) {
  const dot = $(dotId);
  const status = stage?.status || "pending";
  dot.className = `step-dot ${status === "ok" ? "ok" : status === "failed" ? "fail" : "warn"}`;
  $(textId).textContent = stage?.message || "No status information";
}

function hydrate(snapshot) {
  state.snapshot = snapshot;
  hydrateStationControls();
  const issue = parseDate(snapshot.issue_date);
  $("issue-date").textContent = snapshot.issue_date || "No issue date";
  $("data-cutoff").textContent = snapshot.data_cutoff || "—";
  $("next-update").textContent = snapshot.next_scheduled_update || "Manual";
  $("build-info").textContent = `${snapshot.build_id || "snapshot"} · ${snapshot.generated_at || "—"}`;
  const sources = snapshot.data_sources || {};
  $("sic-latest").textContent = sources.sic?.latest_date || "—";
  $("sic-provider").textContent = `${sources.sic?.provider || "SIC provider pending"} · native ${sources.sic?.native_resolution_km || "—"} km`;
  $("era5-latest").textContent = sources.era5?.latest_date || "—";
  $("joint-issue").textContent = snapshot.issue_date || "—";
  $("issue-policy").textContent = sources.issue_policy || "Uses the earlier of the two input dates";
  $("provider-validation").textContent = snapshot.provider?.approved ? "Approved" : "Pending";
  const overlap = snapshot.provider?.overlap;
  $("provider-validation-detail").textContent = overlap?.days
    ? `${overlap.days}-day overlap · MAE ${Number(overlap.mae_pct_sic).toFixed(2)}% · pending approval`
    : "AU_SI12 overlap · route impact gate";
  $("sic-provider-label").textContent = sources.sic?.provider || "Operational SIC";
  $("era5-provider-label").textContent = sources.era5?.provider || "ERA5T causal history";
  const chip = $("freshness-chip");
  chip.className = `status-chip ${snapshot.service_status === "live" ? "live" : snapshot.service_status === "validation" ? "validation" : snapshot.service_status === "failed" ? "failed" : "stale"}`;
  $("freshness-label").textContent = snapshot.service_status_label || snapshot.service_status;
  setPipeline("sic-dot", "sic-status", snapshot.pipeline?.sic);
  setPipeline("era5-dot", "era5-status", snapshot.pipeline?.era5);
  setPipeline("model-dot", "model-status", snapshot.pipeline?.inference);
  setPipeline("route-dot", "route-status", snapshot.pipeline?.route);
  setPipeline("publish-dot", "publish-status", snapshot.pipeline?.publication);

  const available = state.forecastManifest?.anchors || [];
  const fieldsReady = Boolean(snapshot.forecast?.fields_ready && available.length);
  const [minTarget, maxTarget] = forecastDateBounds();
  const targetInput = $("target-date-input");
  const monthInput = $("calendar-month-input");
  targetInput.min = minTarget ? isoDate(minTarget) : "";
  targetInput.max = maxTarget ? isoDate(maxTarget) : "";
  targetInput.disabled = !fieldsReady;
  monthInput.min = issue ? monthValue(issue) : "";
  monthInput.max = maxTarget ? monthValue(maxTarget) : "";
  monthInput.disabled = !fieldsReady;
  $("forecast-date-range").textContent = minTarget && maxTarget
    ? `Target-date range for this issue: ${isoDate(minTarget)} to ${isoDate(maxTarget)}`
    : "No forecast dates are available.";
  $("lead-range").disabled = !fieldsReady;
  document.querySelectorAll(".anchor-row button").forEach((button) => {
    button.disabled = !available.includes(Number(button.dataset.lead));
  });
  hydrateDestinationControl();
  hydrateIceClassControl();
  const today = new Date();
  const todayUtc = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
  ));
  const todayLead = issue ? Math.round((todayUtc - issue) / 86400000) : 1;
  const preferredLead = Math.min(180, Math.max(1, todayLead));
  const defaultLead = available.includes(preferredLead) ? preferredLead : available[0] || 1;
  state.lead = defaultLead;
  state.selectedDate = issue ? addDays(issue, defaultLead) : new Date();
  state.month = new Date(Date.UTC(state.selectedDate.getUTCFullYear(), state.selectedDate.getUTCMonth(), 1));
  updateSelection();
}

async function load() {
  let lastError;
  const endpoints = [
    new URL("/api/v1/status", window.location.origin).toString(),
    siteUrl("data/latest.json"),
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(`${endpoint} status ${response.status}`);
      const snapshot = await response.json();
      state.forecastManifest = null;
      state.routeManifest = null;
      state.historyManifest = null;
      state.stationCatalog = null;
      state.currentRoute = null;
      state.fieldCache.clear();
      try {
        const historyResponse = await fetch(siteUrl("data/history-index.json"), { cache: "no-store" });
        if (historyResponse.ok) {
          const historyManifest = await historyResponse.json();
          if (historyManifest.width === 632 && historyManifest.height === 664) {
            state.historyManifest = historyManifest;
          }
        }
      } catch (historyError) {
        console.error(historyError);
      }
      try {
        const stationResponse = await fetch(siteUrl("data/stations/comnap_stations_nov2024.json"), { cache: "no-store" });
        if (!stationResponse.ok) throw new Error(`station catalog status ${stationResponse.status}`);
        const stationCatalog = await stationResponse.json();
        if (stationCatalog.grid?.width !== 632 || stationCatalog.grid?.height !== 664) {
          throw new Error("station catalog does not match the current SIREN grid");
        }
        state.stationCatalog = stationCatalog;
      } catch (stationError) {
        console.error(stationError);
      }
      if (snapshot.forecast?.fields_ready && snapshot.forecast?.field_manifest_url) {
        const manifestResponse = await fetch(siteUrl(snapshot.forecast.field_manifest_url), { cache: "no-store" });
        if (!manifestResponse.ok) {
          throw new Error(`${snapshot.forecast.field_manifest_url} status ${manifestResponse.status}`);
        }
        const manifest = await manifestResponse.json();
        if (manifest.issue_date !== snapshot.issue_date || manifest.width !== 632 || manifest.height !== 664) {
          throw new Error("forecast manifest does not match the current 632×664 issue");
        }
        state.forecastManifest = manifest;
      }
      if (snapshot.route?.fields_ready && snapshot.route?.route_manifest_url) {
        try {
          const defaultClass = snapshot.route.default_class || snapshot.route.vessel_class || "PC5";
          const defaultDestination = snapshot.route.default_destination || "jang_bogo";
          const routeUrl = snapshot.route.destination_manifests?.[defaultDestination]?.[defaultClass]
            || snapshot.route.class_manifests?.[defaultClass]
            || snapshot.route.route_manifest_url;
          const routeResponse = await fetch(siteUrl(routeUrl), { cache: "no-store" });
          if (!routeResponse.ok) throw new Error(`${routeUrl} status ${routeResponse.status}`);
          const routeManifest = await routeResponse.json();
          if (routeManifest.issue_date !== snapshot.issue_date
              || routeManifest.vessel_class !== defaultClass
              || (routeManifest.destination_id || defaultDestination) !== defaultDestination
              || Object.keys(routeManifest.routes || {}).length !== 180) {
            throw new Error("route manifest does not match the current 180-day destination and ship class");
          }
          state.destination = defaultDestination;
          state.iceClass = defaultClass;
          state.routeManifest = routeManifest;
        } catch (routeError) {
          console.error(routeError);
        }
      }
      hydrate(snapshot);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  $("freshness-label").textContent = "Unable to load status data";
  $("freshness-chip").className = "status-chip failed";
  console.error(lastError);
}

$("destination-select").addEventListener("change", (event) => {
  selectDestination(event.target.value);
});
$("ice-class-select").addEventListener("change", (event) => {
  selectIceClass(event.target.value);
});
$("lead-range").addEventListener("input", (event) => {
  state.lead = Number(event.target.value);
  updateSelection();
});
document.querySelectorAll(".anchor-row button").forEach((button) => {
  button.addEventListener("click", () => {
    state.lead = Number(button.dataset.lead);
    updateSelection();
  });
});
$("target-date-input").addEventListener("change", (event) => {
  const target = parseDate(event.target.value);
  const issue = parseDate(state.snapshot?.issue_date);
  if (!target || !issue) return;
  const lead = Math.round((target - issue) / 86400000);
  if (lead < 1 || lead > Number(state.snapshot?.forecast?.horizon_days || 180)) {
    event.target.value = isoDate(state.selectedDate);
    return;
  }
  state.lead = lead;
  updateSelection();
});
$("target-date-prev").addEventListener("click", () => {
  if (state.lead <= 1) return;
  state.lead -= 1;
  updateSelection();
});
$("target-date-next").addEventListener("click", () => {
  const horizon = Number(state.snapshot?.forecast?.horizon_days || 180);
  if (state.lead >= horizon) return;
  state.lead += 1;
  updateSelection();
});
$("calendar-month-input").addEventListener("change", (event) => {
  if (!/^\d{4}-\d{2}$/.test(event.target.value)) return;
  const [year, month] = event.target.value.split("-").map(Number);
  state.month = new Date(Date.UTC(year, month - 1, 1));
  renderCalendar();
});
$("prev-month").addEventListener("click", () => {
  state.month = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() - 1, 1));
  renderCalendar();
});
$("next-month").addEventListener("click", () => {
  state.month = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  renderCalendar();
});
$("today-month").addEventListener("click", () => {
  const issue = parseDate(state.snapshot?.issue_date);
  if (!issue) return;
  state.month = new Date(Date.UTC(issue.getUTCFullYear(), issue.getUTCMonth(), 1));
  renderCalendar();
});
$("about-button").addEventListener("click", () => $("about-dialog").showModal());
$("station-country").addEventListener("change", async (event) => {
  state.stationCountry = event.target.value;
  hydrateStationControls();
  const destinations = filteredDestinations();
  if (destinations.length && !destinations.includes(state.destination)) {
    await selectDestination(destinations[0]);
  } else {
    hydrateDestinationControl();
    renderCalendar();
  }
  focusCatalogSelection();
});
$("map-zoom").addEventListener("input", (event) => setMapZoom(event.target.value));
$("zoom-in").addEventListener("click", () => setMapZoom(state.mapView.zoom + 0.25));
$("zoom-out").addEventListener("click", () => setMapZoom(state.mapView.zoom - 0.25));
$("zoom-reset").addEventListener("click", () => focusStation("all"));
document.querySelectorAll("[data-station]").forEach((button) => {
  button.addEventListener("click", () => focusStation(button.dataset.station));
});
const mapCanvas = $("ice-map");
mapCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = mapCanvas.getBoundingClientRect();
  const surface = mapSurface();
  const focal = {
    x: (event.clientX - rect.left) * surface.width / rect.width,
    y: (event.clientY - rect.top) * surface.height / rect.height,
  };
  setMapZoom(state.mapView.zoom * (event.deltaY < 0 ? 1.16 : 1 / 1.16), focal);
}, { passive: false });
mapCanvas.addEventListener("pointerdown", (event) => {
  if (state.mapView.zoom <= 1) return;
  state.mapView.dragging = true;
  state.mapView.pointerId = event.pointerId;
  state.mapView.lastX = event.clientX;
  state.mapView.lastY = event.clientY;
  mapCanvas.setPointerCapture(event.pointerId);
  mapCanvas.classList.add("dragging");
});
mapCanvas.addEventListener("pointermove", (event) => {
  if (!state.mapView.dragging || state.mapView.pointerId !== event.pointerId || !state.lastMap) return;
  const rect = mapCanvas.getBoundingClientRect();
  const surface = mapSurface();
  state.mapView.panX += (event.clientX - state.mapView.lastX) * surface.width / rect.width;
  state.mapView.panY += (event.clientY - state.mapView.lastY) * surface.height / rect.height;
  state.mapView.lastX = event.clientX;
  state.mapView.lastY = event.clientY;
  clampMapPan(state.lastMap.field);
  redrawLastMap();
});
function finishMapDrag(event) {
  if (state.mapView.pointerId !== event.pointerId) return;
  state.mapView.dragging = false;
  state.mapView.pointerId = null;
  mapCanvas.classList.remove("dragging");
}
mapCanvas.addEventListener("pointerup", finishMapDrag);
mapCanvas.addEventListener("pointercancel", finishMapDrag);
mapCanvas.addEventListener("dblclick", () => focusStation("all"));
let mapResizeFrame = null;
const redrawAfterResize = () => {
  if (mapResizeFrame !== null) cancelAnimationFrame(mapResizeFrame);
  mapResizeFrame = requestAnimationFrame(() => {
    mapResizeFrame = null;
    mapSurface();
    redrawLastMap();
  });
};
if ("ResizeObserver" in window) {
  new ResizeObserver(redrawAfterResize).observe(mapCanvas);
} else {
  window.addEventListener("resize", redrawAfterResize);
}
load();

