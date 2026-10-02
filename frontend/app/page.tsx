"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Sun, Moon } from "lucide-react";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend,
  type ChartOptions, type ChartData,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend,
);

// ─── Tipler ───────────────────────────────────────────────────────────────────
interface Telemetry {
  timestamp: number;
  state: string;
  elapsed_s: number;
  valve_open: boolean;
  thrust_n: number;
  thrust_target_n: number;
  mdot_ox: number;
  mdot_inj: number;
  mdot_vnt: number;
  mdot_grn: number;
  mdot_noz: number;
  mdot_cmbr: number;
  mdot_ox_target: number;
  pressure_chamber_pa: number;
  pressure_tank_pa: number;
  pressure_noz_exit_pa: number;
  temp_tank_k: number;
  temp_chamber_k: number;
  mass_ox_liq_kg: number;
  mass_ox_vap_kg: number;
  mass_cmbr_stored_kg: number;
  mass_grain_kg: number;
  grain_thickness_m: number;
  net_regression_m: number;
  mach_exit: number;
  cstar_m_s: number;
  chamber_temp_k: number;
  empty_chamber_vol_m3: number;
}

// ─── Sabitler ─────────────────────────────────────────────────────────────────
const MAX_POINTS = 1200;  // 12 saniye @ 100 Hz
const RENDER_INTERVAL = 50;  // ms — 20 Hz render

const toBar = (pa: number) => pa / 1e5;
const toMPa = (pa: number) => pa / 1e6;
const fmt = (v: number, d = 2) => v.toFixed(d);

// ─── Ortak Chart.js seçenekleri (Belge Stili) ───────────────────────────────
function makeOptions(
  yMin: number,
  yMax: number,
  y2?: { min: number; max: number },
): ChartOptions<"line"> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    plugins: {
      legend: {
        display: true,
        labels: {
          color: "#000",
          font: { size: 10, family: "Arial, Helvetica, sans-serif", weight: 'bold' },
          boxWidth: 15,
          padding: 8,
        },
      },
      tooltip: {
        backgroundColor: "#fff",
        titleColor: "#000",
        bodyColor: "#000",
        borderColor: "#000",
        borderWidth: 2,
        titleFont: { size: 11, family: "monospace" },
        bodyFont: { size: 11, family: "monospace" },
        displayColors: false,
        cornerRadius: 0,
      },
    },
    scales: {
      x: {
        ticks: { color: "#000", font: { size: 10, family: "monospace", weight: "bold" }, maxTicksLimit: 6, maxRotation: 0 },
        grid: { color: "#e5e5e5" },
        border: { color: "#000", width: 2 },
      },
      y: {
        min: yMin,
        max: yMax,
        ticks: { color: "#000", font: { size: 10, family: "monospace", weight: "bold" }, maxTicksLimit: 5 },
        grid: { color: "#e5e5e5" },
        border: { color: "#000", width: 2 },
      },
      ...(y2
        ? {
          y2: {
            position: "right" as const,
            min: y2.min,
            max: y2.max,
            ticks: { color: "#000", font: { size: 10, family: "monospace", weight: "bold" }, maxTicksLimit: 5 },
            grid: { drawOnChartArea: false },
            border: { color: "#000", width: 2 },
          },
        }
        : {}),
    },
    elements: {
      point: { radius: 0, hitRadius: 5 },
      line: { tension: 0 }, // Sert, analitik grafik
    },
  };
}

// ─── Grafik kart bileşeni ─────────────────────────────────────────────────────
function ChartCard({
  id, title, badge, children, fullscreen, setFullscreen,
}: {
  id: string; title: string; badge?: React.ReactNode; children: React.ReactNode;
  fullscreen: string | null; setFullscreen: (v: string | null) => void;
}) {
  const isFs = fullscreen === id;
  return (
    <div
      className={`flex flex-col bg-white dark:bg-black border-2 border-black dark:border-white transition-all duration-300
        ${isFs ? "fixed inset-4 md:inset-12 z-50 shadow-2xl ring-4 ring-black dark:ring-white" : "relative h-full"}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0 border-b-2 border-black dark:border-white bg-neutral-100 dark:bg-neutral-900">
        <span className="text-xs font-bold tracking-widest text-black dark:text-white uppercase">
          {title}
        </span>
        <div className="flex items-center gap-4">
          <span className="font-mono font-bold text-sm text-black dark:text-white tabular-nums">{badge}</span>
          <button
            onClick={() => setFullscreen(isFs ? null : id)}
            className="text-black dark:text-white hover:bg-black dark:hover:bg-white hover:text-white dark:hover:text-black px-2 py-0.5 border-2 border-black dark:border-white text-xs transition-none font-bold bg-white dark:bg-black"
          >
            {isFs ? "[ KAPAT ]" : "[ BÜYÜT ]"}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-2 relative bg-white dark:bg-black">{children}</div>
    </div>
  );
}

// ─── Özet metrik kutusu ───────────────────────────────────────────────────────
function Metric({ label, value, unit }: {
  label: string; value: string; unit?: string;
}) {
  return (
    <div className="flex justify-between items-baseline border-b-2 border-dashed border-neutral-300 dark:border-neutral-700 py-1.5">
      <span className="text-[11px] font-bold uppercase text-black dark:text-white">{label}</span>
      <span className="text-sm font-bold font-mono text-black dark:text-white tabular-nums">
        {value} {unit && <span className="text-[10px] font-normal">{unit}</span>}
      </span>
    </div>
  );
}

function sliceArr<T>(prev: T[], next: T[]): T[] {
  return [...prev, ...next].slice(-MAX_POINTS);
}

// ─── Dark Mode Butonu ─────────────────────────────────────────────────────────
function DarkModeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    document.documentElement.classList.toggle("dark");
    setIsDark(document.documentElement.classList.contains("dark"));
  };

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2 px-3 py-1.5 border-2 border-black dark:border-white bg-white dark:bg-black hover:bg-black dark:hover:bg-white hover:text-white dark:hover:text-black transition-none text-xs font-bold uppercase"
      title="Temayı Değiştir"
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
      <span>{isDark ? "Açık Tema" : "Koyu Tema"}</span>
    </button>
  );
}

// ─── Ana bileşen ──────────────────────────────────────────────────────────────
export default function GroundControl() {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<Telemetry | null>(null);
  const [fullscreen, setFullscreen] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // ── Grafik state'leri ───────────────────────────────────────────────────
  const [labels, setLabels] = useState<string[]>([]);
  const [thrustDs, setThrustDs] = useState<{ sim: number[]; tgt: number[] }>({ sim: [], tgt: [] });
  const [mdotDs, setMdotDs] = useState<{ ox: number[]; inj: number[]; grn: number[]; noz: number[] }>({ ox: [], inj: [], grn: [], noz: [] });
  const [pressDs, setPressDs] = useState<{ cmbr: number[]; tank: number[]; noz: number[] }>({ cmbr: [], tank: [], noz: [] });
  const [ttankDs, setTtankDs] = useState<number[]>([]);
  const [massDs, setMassDs] = useState<{ liq: number[]; vap: number[]; grain: number[] }>({ liq: [], vap: [], grain: [] });
  const [grainDs, setGrainDs] = useState<{ thick: number[]; reg: number[] }>({ thick: [], reg: [] });
  const [machDs, setMachDs] = useState<number[]>([]);
  const [cstarDs, setCstarDs] = useState<{ cstar: number[]; cT: number[] }>({ cstar: [], cT: [] });
  const [volDs, setVolDs] = useState<number[]>([]);

  // ── Özet istatistikler ──────────────────────────────────────────────────
  const stats = useRef({
    burnStart: null as number | null,
    burnDuration: 0,
    totalImpulse: 0,
    maxThrust: 0,
    maxPcmbr: 0,
    minTtank: 999,
    maxMach: 0,
    lastElapsed: 0,
    thrustSum: 0,
    thrustCount: 0,
  });
  const [snap, setSnap] = useState({ ...stats.current });

  const bufferRef = useRef<Telemetry[]>([]);
  const prevState = useRef("");

  // ── WebSocket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8080/ws");
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (e) => {
      const d: Telemetry = JSON.parse(e.data);
      setLatest(d);
      bufferRef.current.push(d);

      const s = stats.current;
      if (prevState.current !== "FIRING" && d.state === "FIRING") {
        s.burnStart = d.elapsed_s;
        s.totalImpulse = 0;
        s.thrustSum = 0;
        s.thrustCount = 0;
      }
      if (d.state === "FIRING") {
        const dt = d.elapsed_s - s.lastElapsed;
        if (dt > 0 && dt < 1) s.totalImpulse += d.thrust_n * dt;
        s.burnDuration = s.burnStart !== null ? d.elapsed_s - s.burnStart : 0;
        s.thrustSum += d.thrust_n;
        s.thrustCount += 1;
      }
      if (d.thrust_n > s.maxThrust) s.maxThrust = d.thrust_n;
      if (toBar(d.pressure_chamber_pa) > s.maxPcmbr) s.maxPcmbr = toBar(d.pressure_chamber_pa);
      if (d.temp_tank_k > 50 && d.temp_tank_k < s.minTtank) s.minTtank = d.temp_tank_k;
      if (d.mach_exit > s.maxMach) s.maxMach = d.mach_exit;
      s.lastElapsed = d.elapsed_s;
      prevState.current = d.state;
    };

    return () => ws.close();
  }, []);

  // ── Render döngüsü (50ms) ────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const buf = bufferRef.current.splice(0);
      if (buf.length === 0) return;

      const lbl = buf.map((d) => `${fmt(d.elapsed_s, 1)}s`);

      setLabels((p) => sliceArr(p, lbl));
      setThrustDs((p) => ({ sim: sliceArr(p.sim, buf.map((d) => d.thrust_n)), tgt: sliceArr(p.tgt, buf.map((d) => d.thrust_target_n)) }));
      setMdotDs((p) => ({ ox: sliceArr(p.ox, buf.map((d) => d.mdot_ox)), inj: sliceArr(p.inj, buf.map((d) => d.mdot_inj)), grn: sliceArr(p.grn, buf.map((d) => d.mdot_grn)), noz: sliceArr(p.noz, buf.map((d) => d.mdot_noz)) }));
      setPressDs((p) => ({ cmbr: sliceArr(p.cmbr, buf.map((d) => toMPa(d.pressure_chamber_pa))), tank: sliceArr(p.tank, buf.map((d) => toMPa(d.pressure_tank_pa))), noz: sliceArr(p.noz, buf.map((d) => toMPa(d.pressure_noz_exit_pa))) }));
      setTtankDs((p) => sliceArr(p, buf.map((d) => d.temp_tank_k)));
      setMassDs((p) => ({ liq: sliceArr(p.liq, buf.map((d) => d.mass_ox_liq_kg)), vap: sliceArr(p.vap, buf.map((d) => d.mass_ox_vap_kg)), grain: sliceArr(p.grain, buf.map((d) => d.mass_grain_kg)) }));
      setGrainDs((p) => ({ thick: sliceArr(p.thick, buf.map((d) => d.grain_thickness_m)), reg: sliceArr(p.reg, buf.map((d) => d.net_regression_m)) }));
      setMachDs((p) => sliceArr(p, buf.map((d) => d.mach_exit)));
      setCstarDs((p) => ({ cstar: sliceArr(p.cstar, buf.map((d) => d.cstar_m_s)), cT: sliceArr(p.cT, buf.map((d) => d.chamber_temp_k)) }));
      setVolDs((p) => sliceArr(p, buf.map((d) => d.empty_chamber_vol_m3)));

      setSnap({ ...stats.current });
    }, RENDER_INTERVAL);

    return () => clearInterval(id);
  }, []);

  // ── Komut Fonksiyonları ──────────────────────────────────────────────────
  const sendCommand = (cmd: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: cmd }));
    }
  };

  // ── Chart data (Renkli Stil) ─────────────────────────────────────────────
  const thrustData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "sim/thrust", data: thrustDs.sim, borderColor: "#3b82f6", borderWidth: 1.5 },
      { label: "target/100N", data: thrustDs.tgt, borderColor: "#ef4444", borderWidth: 1, borderDash: [4, 4] },
    ],
  }), [labels, thrustDs]);

  const mdotData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "ox", data: mdotDs.ox, borderColor: "#10b981", borderWidth: 1.5 },
      { label: "inj", data: mdotDs.inj, borderColor: "#8b5cf6", borderWidth: 1.2, borderDash: [5, 5] },
      { label: "grn", data: mdotDs.grn, borderColor: "#d946ef", borderWidth: 1.2, borderDash: [2, 2] },
      { label: "noz", data: mdotDs.noz, borderColor: "#f59e0b", borderWidth: 1.2, borderDash: [10, 5] },
    ],
  }), [labels, mdotDs]);

  const pressData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "chamber", data: pressDs.cmbr, borderColor: "#ef4444", borderWidth: 1.5 },
      { label: "tank", data: pressDs.tank, borderColor: "#3b82f6", borderWidth: 1.2, borderDash: [5, 5] },
      { label: "noz exit", data: pressDs.noz, borderColor: "#8b5cf6", borderWidth: 1.2, borderDash: [2, 2] },
    ],
  }), [labels, pressDs]);

  const ttankData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [{ label: "T_tank", data: ttankDs, borderColor: "#f97316", borderWidth: 1.5 }],
  }), [labels, ttankDs]);

  const massData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "liq", data: massDs.liq, borderColor: "#0ea5e9", borderWidth: 1.5 },
      { label: "vap", data: massDs.vap, borderColor: "#a855f7", borderWidth: 1.2, borderDash: [5, 5] },
      { label: "grain", data: massDs.grain, borderColor: "#84cc16", borderWidth: 1.2, borderDash: [2, 2] },
    ],
  }), [labels, massDs]);

  const grainData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "thickm", data: grainDs.thick, borderColor: "#f43f5e", borderWidth: 1.5 },
      { label: "net_reg", data: grainDs.reg, borderColor: "#eab308", borderWidth: 1.2, borderDash: [5, 5] },
    ],
  }), [labels, grainDs]);

  const machData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [{ label: "Mach", data: machDs, borderColor: "#06b6d4", borderWidth: 1.5 }],
  }), [labels, machDs]);

  const cstarData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [
      { label: "cstar", data: cstarDs.cstar, borderColor: "#ec4899", borderWidth: 1.5, yAxisID: "y" },
      { label: "cmbr T", data: cstarDs.cT, borderColor: "#f97316", borderWidth: 1.2, borderDash: [5, 5], yAxisID: "y2" },
    ],
  }), [labels, cstarDs]);

  const volData = useMemo<ChartData<"line">>(() => ({
    labels,
    datasets: [{ label: "Empty cmbr V", data: volDs, borderColor: "#6366f1", borderWidth: 1.5 }],
  }), [labels, volDs]);

  // ── Türetilmiş değerler ───────────────────────────────────────────────────
  const isFiring = latest?.state === "FIRING";
  const avgThrust = snap.thrustCount > 0 ? snap.thrustSum / snap.thrustCount : 0;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white dark:bg-black text-black dark:text-white font-sans selection:bg-neutral-300 dark:bg-neutral-700 overflow-hidden">

      {fullscreen && (
        <div
          className="fixed inset-0 z-40 bg-white dark:bg-black/90 backdrop-blur-sm"
          onClick={() => setFullscreen(null)}
        />
      )}
      {/* ── Header (Resmi Doküman Stili) ──────────────────────────────────── */}
      <header className="flex justify-between items-center border-b-4 border-black dark:border-white px-5 py-3 bg-white dark:bg-black sticky top-0 z-30">
        <div>
          <h1 className="text-xl font-black tracking-widest text-black dark:text-white uppercase">
            FORM: TELEMETRİ & RAPORLAMA KONTROL
          </h1>
          <p className="text-[10px] text-black dark:text-white font-bold tracking-widest">
            HİBRİT ROKET STATİK ATEŞLEME (MOCK-UP)
          </p>
        </div>
        <DarkModeToggle />
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2 px-3 py-1 border-2 border-black dark:border-white text-xs font-bold uppercase transition-colors bg-neutral-100 dark:bg-neutral-900">
            {connected ? "BAĞLANTI: OPTİMAL (100 Hz)" : "BAĞLANTI: KAYIP"}
          </div>
          <div className={`flex items-center gap-2 px-3 py-1 border-2 border-black dark:border-white text-xs font-bold uppercase
            ${isFiring ? "bg-black text-white" : "bg-white dark:bg-black text-black dark:text-white"}`}>
            DURUM: {latest?.state ?? "BEKLENİYOR"}
          </div>
        </div>
      </header>

      {/* ── Ana Layout ────────────────────────────────────────────────────── */}
      <div className="flex" style={{ height: "calc(100vh - 60px)" }}>

        {/* Sol panel (Kontrol ve Anlık Değerler) */}
        <aside className="w-56 shrink-0 border-r-2 border-black dark:border-white flex flex-col p-4 gap-6 overflow-y-auto bg-neutral-50 dark:bg-neutral-950">

          <div className="space-y-3">
            <h2 className="text-sm font-black border-b-2 border-black dark:border-white pb-1">ETKİLEŞİM PANELİ</h2>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => sendCommand("START")}
                className="w-full py-2 bg-white dark:bg-black text-black dark:text-white border-2 border-black dark:border-white hover:bg-black dark:hover:bg-white hover:text-white dark:hover:text-black transition-none text-xs font-black uppercase tracking-widest"
              >
                [ ATEŞLE / BAŞLAT ]
              </button>
              <button
                onClick={() => sendCommand("ABORT")}
                className="w-full py-2 bg-white dark:bg-black text-black dark:text-white border-2 border-black dark:border-white hover:bg-neutral-800 hover:text-white dark:hover:text-black transition-none text-xs font-bold uppercase"
              >
                [ ABORT / İPTAL ]
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-black border-b-2 border-black dark:border-white pb-1">SİSTEM BİLGİSİ</h2>
            <div className="flex justify-between items-center text-xs font-bold">
              <span>ANA VANA:</span>
              <span className={latest?.valve_open ? "border-b border-black dark:border-white" : ""}>
                {latest?.valve_open ? "AÇIK" : "KAPALI"}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs font-bold">
              <span>ZAMAN (t):</span>
              <span className="font-mono">{fmt(latest?.elapsed_s ?? 0, 2)} s</span>
            </div>
          </div>

          <div className="space-y-1">
            <h2 className="text-sm font-black border-b-2 border-black dark:border-white pb-1 mb-2">ANLIK SKALARLAR</h2>
            {([
              { l: "İTKİ", v: fmt(latest?.thrust_n ?? 0, 1), u: "N" },
              { l: "P_CMBR", v: fmt(toBar(latest?.pressure_chamber_pa ?? 0), 2), u: "bar" },
              { l: "P_TANK", v: fmt(toBar(latest?.pressure_tank_pa ?? 0), 1), u: "bar" },
              { l: "T_TANK", v: fmt(latest?.temp_tank_k ?? 0, 1), u: "K" },
              { l: "MACH_EX", v: fmt(latest?.mach_exit ?? 0, 3), u: "" },
              { l: "C*", v: fmt(latest?.cstar_m_s ?? 0, 0), u: "m/s" },
            ] as const).map(({ l, v, u }) => (
              <div key={l} className="flex justify-between items-baseline border-b border-dotted border-neutral-400 dark:border-neutral-600 pb-1">
                <span className="text-xs font-bold">{l}</span>
                <span className="text-xs font-mono font-bold">
                  {v} <span className="font-normal">{u}</span>
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* Grafik grid — 3×3 */}
        <main
          className="flex-1 overflow-y-auto p-4 grid grid-cols-3 gap-4 bg-white dark:bg-black"
          style={{ gridTemplateRows: "repeat(3, minmax(0, 1fr))" }}
        >
          {/* 1 */}
          <ChartCard id="thrust" title="GRAFİK I: İTKİ (N)" fullscreen={fullscreen} setFullscreen={setFullscreen}
            badge={`${fmt(latest?.thrust_n ?? 0, 1)} N`}>
            <Line options={makeOptions(0, 120)} data={thrustData} />
          </ChartCard>

          {/* 2 */}
          <ChartCard id="mdot" title="GRAFİK II: KÜTLESEL DEBİ" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(-0.07, 0.07)} data={mdotData} />
          </ChartCard>

          {/* 3 */}
          <ChartCard id="pressure" title="GRAFİK III: BASINÇ (MPa)" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(0, 6)} data={pressData} />
          </ChartCard>

          {/* 4 */}
          <ChartCard id="ttank" title="GRAFİK IV: TANK SICAKLIĞI (K)" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(255, 300)} data={ttankData} />
          </ChartCard>

          {/* 5 */}
          <ChartCard id="mass" title="GRAFİK V: KÜTLE DAĞILIMI (kg)" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(0, 0.45)} data={massData} />
          </ChartCard>

          {/* 6 */}
          <ChartCard id="grain" title="GRAFİK VI: YAKIT REGRESYONU" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(0, 0.03)} data={grainData} />
          </ChartCard>

          {/* 7 */}
          <ChartCard id="mach" title="GRAFİK VII: MACH ÇIKIŞ" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(2.0, 2.4)} data={machData} />
          </ChartCard>

          {/* 8 */}
          <ChartCard id="cstar" title="GRAFİK VIII: C* VE YANMA ODASI (K)" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(1400, 1800, { min: 1400, max: 1800 })} data={cstarData} />
          </ChartCard>

          {/* 9 */}
          <ChartCard id="vol" title="GRAFİK IX: BOŞ HACİM (m³)" fullscreen={fullscreen} setFullscreen={setFullscreen}>
            <Line options={makeOptions(0.00035, 0.00043)} data={volData} />
          </ChartCard>
        </main>

        {/* Sağ özet paneli */}
        <aside className="w-56 shrink-0 border-l-2 border-black dark:border-white flex flex-col p-4 bg-neutral-50 dark:bg-neutral-950 overflow-y-auto">
          <h2 className="text-sm font-black border-b-2 border-black dark:border-white pb-1 mb-4 uppercase">Test Özeti ve Skor</h2>

          <div className="space-y-0.5">
            <Metric label="Yanma Süresi" value={fmt(snap.burnDuration, 2)} unit="s" />
            <Metric label="Toplam İmpuls" value={fmt(snap.totalImpulse, 1)} unit="Ns" />
            <Metric label="Maks İtki" value={fmt(snap.maxThrust, 1)} unit="N" />
            <Metric label="Ortalama İtki" value={avgThrust > 0 ? fmt(avgThrust, 1) : "—"} unit="N" />
            <Metric label="Maks P Cmbr" value={fmt(snap.maxPcmbr, 2)} unit="bar" />
            <Metric label="Min T Tank" value={snap.minTtank < 900 ? fmt(snap.minTtank, 1) : "—"} unit="K" />
            <Metric label="Maks Mach" value={fmt(snap.maxMach, 3)} />
            <Metric label="Hedef İtki Gösterimi" value="100.0" unit="N" />
          </div>

        </aside>

      </div>
    </div>
  );
}