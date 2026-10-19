// Custom-start route search, run off the main thread.
// Mirrors worker/generate_routes.py (astar_time, reconstruct, route_metrics) including
// its float32/float64 arithmetic so a standard-approach start reproduces the published
// routes exactly. POLARIS costs come from data/routing/routing.json lookup tables built
// by scripts/build_routing_assets.py with the same Python code path.

const cache = new Map();

async function fetchBytes(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url} status ${response.status}`);
      return response.arrayBuffer();
    }).catch((error) => {
      cache.delete(url);
      throw error;
    }));
  }
  return cache.get(url);
}

async function fetchJson(url) {
  const buffer = await fetchBytes(url);
  return JSON.parse(new TextDecoder().decode(buffer));
}

const resolve = (base, path) => new URL(String(path).replace(/^\/+/, ""), base).toString();

// CPython float floor division (numba follows the same algorithm).
function floorDiv(a, b) {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod && ((b < 0) !== (mod < 0))) div -= 1;
  if (!div) return 0;
  let floor = Math.floor(div);
  if (div - floor > 0.5) floor += 1;
  return floor;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Binary min-heap ordered like Python tuples (f, g, row, column).
class Heap {
  constructor() {
    this.size = 0;
    this.grow(1 << 16);
  }
  grow(capacity) {
    const copy = (Type, old) => { const next = new Type(capacity); if (old) next.set(old); return next; };
    this.f = copy(Float64Array, this.f);
    this.g = copy(Float64Array, this.g);
    this.r = copy(Int32Array, this.r);
    this.c = copy(Int32Array, this.c);
  }
  less(i, j) {
    if (this.f[i] !== this.f[j]) return this.f[i] < this.f[j];
    if (this.g[i] !== this.g[j]) return this.g[i] < this.g[j];
    if (this.r[i] !== this.r[j]) return this.r[i] < this.r[j];
    return this.c[i] < this.c[j];
  }
  swap(i, j) {
    for (const key of ["f", "g", "r", "c"]) {
      const value = this[key][i]; this[key][i] = this[key][j]; this[key][j] = value;
    }
  }
  push(f, g, r, c) {
    if (this.size === this.f.length) this.grow(this.f.length * 2);
    let i = this.size++;
    this.f[i] = f; this.g[i] = g; this.r[i] = r; this.c[i] = c;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const top = [this.f[0], this.g[0], this.r[0], this.c[0]];
    const last = --this.size;
    if (last > 0) {
      this.f[0] = this.f[last]; this.g[0] = this.g[last]; this.r[0] = this.r[last]; this.c[0] = this.c[last];
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < last && this.less(left, smallest)) smallest = left;
        if (right < last && this.less(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }
}

const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];

function astarTime(costs, ndays, height, width, si, sj, gi, gj) {
  const cells = height * width;
  const distance = new Float32Array(cells).fill(Infinity);
  const parent = new Int32Array(cells).fill(-1);
  const closed = new Uint8Array(cells);
  distance[si * width + sj] = 0;
  let minimum = Infinity;
  for (let index = 0; index < costs.length; index++) {
    const value = costs[index];
    if (Number.isFinite(value) && value < minimum) minimum = value;
  }
  const heap = new Heap();
  heap.push(Math.sqrt((si - gi) ** 2 + (sj - gj) ** 2) * minimum, 0, si, sj);
  let visited = 0;
  while (heap.size) {
    const [, insertedG, row, column] = heap.pop();
    const cell = row * width + column;
    const currentG = distance[cell];
    if (insertedG > currentG + 1e-5) continue;
    if (closed[cell]) continue;
    closed[cell] = 1;
    if (row === gi && column === gj) break;
    visited += 1;
    const day = Math.min(floorDiv(currentG, 24), ndays - 1);
    const offset = day * cells;
    const currentCost = costs[offset + cell];
    for (let index = 0; index < 8; index++) {
      const nr = row + DR[index];
      const nc = column + DC[index];
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const next = nr * width + nc;
      if (closed[next]) continue;
      const nextCost = costs[offset + next];
      if (!Number.isFinite(nextCost)) continue;
      const scale = DR[index] !== 0 && DC[index] !== 0 ? 1.41421356237 : 1.0;
      // numba: float32 + float32 stays float32, the rest is float64.
      const candidate = currentG + scale * 0.5 * Math.fround(currentCost + nextCost);
      if (candidate < distance[next]) {
        distance[next] = candidate;
        parent[next] = cell;
        heap.push(candidate + Math.sqrt((nr - gi) ** 2 + (nc - gj) ** 2) * minimum, candidate, nr, nc);
      }
    }
  }
  return { eta: distance[gi * width + gj], parent, visited };
}

function reconstruct(parent, width, start, goal) {
  const startCell = start[0] * width + start[1];
  const goalCell = goal[0] * width + goal[1];
  if (parent[goalCell] < 0 && startCell !== goalCell) return [];
  const path = [goalCell];
  let current = goalCell;
  while (current !== startCell) {
    current = parent[current];
    if (current < 0) return [];
    path.push(current);
  }
  return path.reverse().map((cell) => [Math.floor(cell / width), cell % width]);
}

async function loadInputs(base) {
  const meta = await fetchJson(resolve(base, "data/routing/routing.json"));
  const [nogo, lat, lon] = await Promise.all([
    fetchBytes(resolve(base, meta.files.nogo)).then((b) => new Uint8Array(b)),
    fetchBytes(resolve(base, meta.files.lat)).then((b) => new Float32Array(b)),
    fetchBytes(resolve(base, meta.files.lon)).then((b) => new Float32Array(b)),
  ]);
  return { meta, nogo, lat, lon };
}

function thicknessUrl(base, meta, month) {
  return resolve(base, meta.files.thickness_bin.replace("{MM}", String(month).padStart(2, "0")));
}

// Nearest navigable cell, same metric as generate_routes.nearest_ocean.
function nearestOcean(inputs, latitude, longitude) {
  const { lat, lon, nogo } = inputs;
  const cos2 = Math.cos(latitude * Math.PI / 180) ** 2;
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < nogo.length; index++) {
    if (nogo[index]) continue;
    const dlon = ((((lon[index] - longitude + 180) % 360) + 360) % 360) - 180;
    const distance = (lat[index] - latitude) ** 2 + cos2 * dlon ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function solve(request) {
  const { base, issueDate, lead, iceClass, goal, fieldUrls } = request;
  const inputs = await loadInputs(base);
  const { meta, nogo, lat, lon } = inputs;
  const { width, height } = meta;
  const cells = width * height;
  const tables = meta.classes[iceClass];
  if (!tables) throw new Error(`${iceClass} is not supported for custom-start routing`);

  let startCell;
  if (request.startGrid) {
    startCell = request.startGrid[0] * width + request.startGrid[1];
  } else {
    startCell = nearestOcean(inputs, request.startLatLon[0], request.startLatLon[1]);
    if (startCell < 0) throw new Error("no navigable ocean cell found");
  }
  const start = [Math.floor(startCell / width), startCell % width];
  const startInfo = {
    grid: start,
    latlon: [round(lat[startCell], 5), round(lon[startCell], 5)],
    normalized: [round(start[1] / (width - 1), 6), round(start[0] / (height - 1), 6)],
    snap_km: request.startLatLon
      ? round(haversineKm(request.startLatLon[0], request.startLatLon[1], lat[startCell], lon[startCell]), 1)
      : 0,
  };

  const days = meta.voyage_days;
  const horizon = meta.horizon_days;
  const leads = Array.from({ length: days }, (_, day) => Math.min(horizon, lead + day));
  const months = leads.map((value) => Number(addDaysIso(issueDate, value).slice(5, 7)));
  const [sicFields, binFields] = await Promise.all([
    Promise.all(leads.map((value) => fetchBytes(fieldUrls[value]).then((b) => new Uint8Array(b)))),
    Promise.all([...new Set(months)].map(async (month) => [
      month, new Uint8Array(await fetchBytes(thicknessUrl(base, meta, month))),
    ])).then((pairs) => new Map(pairs)),
  ]);
  const costTable = Float32Array.from(tables.cost_hours.flat(), (v) => (v === null ? Infinity : v));
  const rioTable = tables.rio.flat();
  const speedTable = tables.speed_kn.flat();
  const costs = new Float32Array(days * cells);
  for (let day = 0; day < days; day++) {
    const sic = sicFields[day];
    const bins = binFields.get(months[day]);
    if (sic.length !== cells) throw new Error(`L+${leads[day]} field has ${sic.length} cells`);
    const offset = day * cells;
    for (let index = 0; index < cells; index++) {
      const value = sic[index] === 255 ? 0 : sic[index];
      costs[offset + index] = nogo[index] ? Infinity : costTable[bins[index] * 101 + value];
    }
  }

  const { eta, parent, visited } = astarTime(costs, days, height, width, start[0], start[1], goal[0], goal[1]);
  const common = {
    lead,
    departure_date: addDaysIso(issueDate, lead),
    horizon_clamped: lead + days - 1 > horizon,
    search_nodes: visited,
    ice_class: iceClass,
    custom_start: startInfo,
  };
  const beyondHorizon = Number.isFinite(eta) && eta > days * 24;
  if (!Number.isFinite(eta) || beyondHorizon) {
    return {
      ...common, status: "no_path", recommendation: "hold",
      eta_hours: null, eta_days: null, route_length_km: null,
      min_rio: null, min_speed_kn: null, path: [], path_latlon: [],
      no_path_reason: beyondHorizon ? "beyond_horizon" : "unreachable",
    };
  }
  const path = reconstruct(parent, width, start, goal);
  if (!path.length) throw new Error("path reconstruction failed");

  let elapsed = 0;
  let length = 0;
  let minRio = Infinity;
  let minSpeed = Infinity;
  path.forEach(([row, column], index) => {
    const cell = row * width + column;
    const day = Math.min(floorDiv(elapsed, 24), days - 1);
    const sic = sicFields[day][cell] === 255 ? 0 : sicFields[day][cell];
    const tableIndex = binFields.get(months[day])[cell] * 101 + sic;
    minRio = Math.min(minRio, rioTable[tableIndex]);
    minSpeed = Math.min(minSpeed, speedTable[tableIndex]);
    if (index === path.length - 1) return;
    const [nr, nc] = path[index + 1];
    const scale = row !== nr && column !== nc ? Math.SQRT2 : 1;
    const offset = day * cells;
    elapsed += scale * 0.5 * (costs[offset + cell] + costs[offset + nr * width + nc]);
    length += meta.cell_km * scale;
  });

  const stride = 3;
  const display = path.filter((_, index) => index % stride === 0);
  if (display[display.length - 1] !== path[path.length - 1]) display.push(path[path.length - 1]);
  return {
    ...common, status: "route_found",
    recommendation: eta <= meta.go_hours ? "go" : "hold",
    eta_hours: round(eta, 2), eta_days: round(eta / 24, 2),
    route_length_km: round(length, 1), min_rio: round(minRio, 2), min_speed_kn: round(minSpeed, 2),
    path_points_full: path.length,
    path: display.map(([r, c]) => [round(c / (width - 1), 6), round(r / (height - 1), 6)]),
    path_latlon: display.map(([r, c]) => [round(lat[r * width + c], 5), round(lon[r * width + c], 5)]),
  };
}

// Grid cell -> lat/lon, used when START is dragged on the map.
async function cellLatLon({ base, cell }) {
  const { meta, lat, lon } = await loadInputs(base);
  const index = cell[0] * meta.width + cell[1];
  return [lat[index], lon[index]];
}

self.onmessage = async (event) => {
  const { id } = event.data;
  try {
    const result = event.data.type === "cell" ? await cellLatLon(event.data) : await solve(event.data);
    self.postMessage({ id, ok: true, route: result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
