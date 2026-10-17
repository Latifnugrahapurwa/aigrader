/**
 * AI Grader Sistem — koreksi LJK otomatis dengan Gemini Vision (client-side only)
 *
 * Instalasi paket:
 *   npm i lucide-react html2canvas jspdf
 * Tailwind CSS harus sudah aktif di proyek (utility class bawaan saja, tanpa konfigurasi khusus).
 *
 * Catatan: bagian yang dicetak/diekspor (laporan PDF & template LJK) memakai inline style
 * berwarna hex agar kompatibel dengan html2canvas (tidak mendukung warna oklch milik Tailwind v4).
 */
import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  GraduationCap, Settings, KeyRound, ScanLine, Table2, FileText, Upload, Trash2,
  Download, Printer, Loader2, CheckCircle2, XCircle, AlertTriangle, Eye, EyeOff,
  Play, ChevronDown, ChevronUp, ImagePlus, FileDown, RotateCcw, X,
} from "lucide-react";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

/* ───────────────────────── Konstanta & helper ───────────────────────── */

const LETTERS = ["A", "B", "C", "D", "E"];
const STORAGE_KEY = "ai-grader-sistem:v1";
const PAGE_W = 794; // A4 @96dpi
const PAGE_H = 1123;
const FIRST_PAGE_ROWS = 22;
const NEXT_PAGE_ROWS = 30;
const FOOTER_ROWS = 10;

const today = () => new Date().toISOString().slice(0, 10);

const DEFAULT_SETTINGS = {
  apiKey: "",
  remember: false,
  model: "gemini-3.5-flash-lite",
  autoModel: true,
  instansi: "",
  schoolName: "SMA Negeri 1 Contoh",
  address: "Jl. Pendidikan No. 1, Kota Contoh",
  examTitle: "Penilaian Tengah Semester",
  tahunAjaran: "2026/2027",
  subject: "Matematika",
  className: "X-1",
  date: today(),
  city: "Kota Contoh",
  teacher: "Nama Guru, S.Pd.",
  teacherNip: "",
  principal: "Nama Kepala Sekolah, M.Pd.",
  principalNip: "",
  kkm: 75,
  totalQ: 40,
};

const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "LJK";

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normLetter(v) {
  const c = String(v ?? "").trim().toUpperCase().charAt(0);
  return LETTERS.includes(c) ? c : "";
}

function grade(student, key) {
  let correct = 0, wrong = 0, blank = 0, total = 0;
  key.forEach((k, i) => {
    if (!k) return;
    total++;
    const a = student.answers[i + 1];
    if (!a) blank++;
    else if (a === k) correct++;
    else wrong++;
  });
  const score = total ? Math.round((correct / total) * 1000) / 10 : 0;
  return { correct, wrong, blank, total, score };
}

function paginate(rows) {
  const pages = [];
  let i = 0;
  while (i < rows.length) {
    const cap = pages.length === 0 ? FIRST_PAGE_ROWS : NEXT_PAGE_ROWS;
    pages.push({ rows: rows.slice(i, i + cap), footer: false });
    i += cap;
  }
  if (pages.length === 0) pages.push({ rows: [], footer: false });
  const capLast = pages.length === 1 ? FIRST_PAGE_ROWS : NEXT_PAGE_ROWS;
  if (pages[pages.length - 1].rows.length <= capLast - FOOTER_ROWS) pages[pages.length - 1].footer = true;
  else pages.push({ rows: [], footer: true });
  return pages;
}

/* ───────────────────────── Gemini Vision ───────────────────────── */

function buildPrompt(n) {
  return (
    `Analisis gambar LJK ini, deteksi nama siswa dan jawaban pilihan ganda nomor 1 sampai ${n}.\n` +
    `Outputkan JSON murni:\n` +
    `{\n"name": "NAMA SISWA",\n"answers": [\n{ "no": 1, "ans": "A" },\n{ "no": 2, "ans": "B" }\n]\n}\n\n` +
    `Aturan:\n` +
    `- Nama siswa ditulis tangan pada baris "Nama" di kotak identitas (biasanya kanan atas). Abaikan teks cetak seperti nama sekolah.\n` +
    `- Jawaban hanya huruf A, B, C, D, atau E.\n` +
    `- Jawaban siswa bisa berupa tanda silang (X) atau bulatan yang dihitamkan (●).\n` +
    `- Jika sebuah nomor kosong, tidak jelas, atau ditandai lebih dari satu pilihan, isi "ans" dengan "-".\n` +
    `- LJK berbentuk tabel dengan beberapa kotak; tiap kotak berisi 10 nomor berurutan ` +
    `(kotak 1 nomor 1–10, kotak 2 nomor 11–20, dan seterusnya). Baca kotak dari kiri ke kanan, lalu baris kotak berikutnya. ` +
    `Gunakan nomor yang tercetak di sebelah kiri setiap baris.\n` +
    `- Abaikan deretan huruf A B C D E di bawah tiap kotak; itu hanya penanda, bukan soal.\n` +
    `- Sertakan semua nomor dari 1 sampai ${n}.\n` +
    `- Balas hanya dengan JSON, tanpa penjelasan dan tanpa tanda markdown.`
  );
}

function parseJson(text) {
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(t.replace(/'/g, '"'));
  }
}

function prepareImage(file, maxSide = 1800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * r);
      const h = Math.round(img.height * r);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gambar tidak dapat dibaca."));
    };
    img.src = url;
  });
}

function versionOf(id) {
  const m = String(id).match(/^gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Prioritas: Flash-Lite > Flash > lainnya, lalu versi tertinggi, lalu rilis stabil (bukan preview/exp/alias latest)
function pickBestModel(list) {
  const rank = (id) => [
    /flash-lite/.test(id) ? 2 : /flash/.test(id) ? 1 : 0,
    versionOf(id),
    /(preview|exp|latest|\d{2}-\d{2})/.test(id) ? 0 : 1,
  ];
  return [...list].sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return 0;
  })[0].id;
}

// Memeriksa API key sekaligus mengambil daftar model Gemini yang bisa dipakai (generateContent)
async function listModels(apiKey) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey.trim() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `API key tidak dapat diperiksa (${res.status}).`);
    (data.models || []).forEach((m) => {
      if ((m.supportedGenerationMethods || []).includes("generateContent")) {
        out.push({ id: String(m.name).replace(/^models\//, ""), label: m.displayName || m.name });
      }
    });
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out.filter((m) => /^gemini-/.test(m.id) && !/(tts|image|embedding|live|audio|robotics|computer-use|learnlm)/.test(m.id));
}

async function callGemini({ apiKey, model, base64, totalQ }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.trim())}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: buildPrompt(totalQ) }, { inlineData: { mimeType: "image/jpeg", data: base64 } }] }],
    // Gemini 3+ disarankan memakai temperature bawaan; model lama dipaksa 0 agar hasil konsisten
    generationConfig: { ...(versionOf(model.trim()) < 3 ? { temperature: 0 } : {}), responseMimeType: "application/json" },
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error(data?.promptFeedback?.blockReason ? `Diblokir: ${data.promptFeedback.blockReason}` : "Gemini tidak mengembalikan jawaban.");
      let obj;
      try {
        obj = parseJson(text);
      } catch {
        throw new Error("Format jawaban Gemini bukan JSON yang valid. Coba ulangi.");
      }
      const answers = {};
      (Array.isArray(obj.answers) ? obj.answers : []).forEach((a) => {
        const no = Number(a?.no);
        if (no >= 1 && no <= totalQ) answers[no] = normLetter(a?.ans);
      });
      return { name: String(obj.name || "").trim().toUpperCase(), answers };
    }
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await sleep(2500 * (attempt + 1));
      continue;
    }
    throw new Error(
      (data?.error?.message || `Permintaan gagal (${res.status}).`) +
        (res.status === 404 ? " Model tidak ditemukan. Tekan “Cek API key” di tab Pengaturan untuk memilih model yang tersedia." : "")
    );
  }
  throw new Error("Permintaan gagal.");
}

/* ───────────────────────── Ekspor PDF ───────────────────────── */

async function pagesToCanvasImages(elements) {
  const imgs = [];
  for (const el of elements) {
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
    imgs.push(canvas.toDataURL("image/jpeg", 0.92));
  }
  return imgs;
}

async function exportPagesToPdf(elements, filename) {
  const imgs = await pagesToCanvasImages(elements);
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  imgs.forEach((img, i) => {
    if (i > 0) pdf.addPage();
    pdf.addImage(img, "JPEG", 0, 0, 210, 297);
  });
  pdf.save(filename);
}

/* ───────────────────────── Komponen UI kecil ───────────────────────── */

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";
const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";

function Card({ title, icon: Icon, children, action }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            {Icon && <Icon className="h-5 w-5 text-indigo-600" />}
            {title}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

function StatusChip({ status }) {
  const map = {
    menunggu: ["bg-slate-100 text-slate-700", "Menunggu"],
    memproses: ["bg-indigo-100 text-indigo-700", "Memproses"],
    selesai: ["bg-emerald-100 text-emerald-700", "Selesai"],
    gagal: ["bg-rose-100 text-rose-700", "Gagal"],
  };
  const [cls, label] = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status === "memproses" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === "selesai" && <CheckCircle2 className="h-3 w-3" />}
      {status === "gagal" && <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function StatBox({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center shadow-sm">
      <div className="text-xl font-semibold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ScaledPage({ children }) {
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const calc = () => setScale(Math.min(1, el.clientWidth / PAGE_W));
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={wrapRef}
      className="w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      style={{ height: PAGE_H * scale }}
    >
      <div style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
    </div>
  );
}

/* ───────────────────────── Halaman laporan (inline style, hex) ───────────────────────── */

function fitBox(logo, box) {
  if (!logo) return null;
  const s = Math.min(box / logo.w, box / logo.h);
  return { w: Math.max(1, Math.round(logo.w * s)), h: Math.max(1, Math.round(logo.h * s)) };
}

// Kop surat: logo kiri, teks tengah, logo kanan, garis tebal-tipis. Dipakai di LJK dan laporan.
function Kop({ meta, logoL, logoR }) {
  const BOX = 80;
  const lines = String(meta.instansi || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const logoBox = (l) => {
    const f = fitBox(l, BOX);
    return (
      <div style={{ width: BOX, height: BOX, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {f && <img src={l.src} alt="" style={{ width: f.w, height: f.h, display: "block" }} />}
      </div>
    );
  };
  const big = { fontSize: 15, fontWeight: 700, fontFamily: "Arial, Helvetica, sans-serif", lineHeight: "20px" };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {logoBox(logoL)}
        <div style={{ flex: 1, textAlign: "center" }}>
          {lines.map((t, i) => (
            <div key={i} style={big}>{t.toUpperCase()}</div>
          ))}
          <div style={big}>{String(meta.schoolName || "").toUpperCase()}</div>
          {meta.address && (
            <div style={{ fontSize: 11, fontStyle: "italic", fontFamily: '"Times New Roman", Times, serif', lineHeight: "14px" }}>
              {meta.address}
            </div>
          )}
        </div>
        {logoBox(logoR)}
      </div>
      <div style={{ marginTop: 6, borderTop: "3px solid #000000" }} />
      <div style={{ marginTop: 2, borderTop: "1px solid #000000" }} />
    </div>
  );
}

const th = { border: "1px solid #000000", padding: "0 6px", background: "#e5e7eb", fontSize: 12, height: 32, lineHeight: "30px", boxSizing: "border-box", textAlign: "center", fontWeight: 700 };
const td = { border: "1px solid #000000", padding: "0 6px", fontSize: 12, height: 28, lineHeight: "26px", boxSizing: "border-box", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

function ReportPage({ meta, logoL, logoR, rows, startIndex, pageNo, pageCount, first, footer, stats, kkm, totalQ }) {
  return (
    <div
      data-page
      style={{
        width: PAGE_W, height: PAGE_H, boxSizing: "border-box", padding: "48px 56px", background: "#ffffff",
        color: "#111827", fontFamily: '"Times New Roman", Times, serif', position: "relative", overflow: "hidden",
      }}
    >
      {first ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <Kop meta={meta} logoL={logoL} logoR={logoR} />
          </div>
          <div style={{ textAlign: "center", fontWeight: 700, fontSize: 15, marginBottom: 2 }}>LAPORAN HASIL KOREKSI LEMBAR JAWABAN KOMPUTER</div>
          <div style={{ textAlign: "center", fontSize: 13, marginBottom: 12 }}>{meta.examTitle}{meta.tahunAjaran ? ` — Tahun Ajaran ${meta.tahunAjaran}` : ""}</div>
          <table style={{ fontSize: 12, marginBottom: 12, width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ width: 110, padding: "1px 0" }}>Mata Pelajaran</td><td style={{ width: 12 }}>:</td><td>{meta.subject}</td>
                <td style={{ width: 110 }}>Tanggal</td><td style={{ width: 12 }}>:</td><td>{fmtDate(meta.date)}</td>
              </tr>
              <tr>
                <td style={{ padding: "1px 0" }}>Kelas</td><td>:</td><td>{meta.className}</td>
                <td>Jumlah Soal</td><td>:</td><td>{totalQ}</td>
              </tr>
              <tr>
                <td style={{ padding: "1px 0" }}>Jumlah Siswa</td><td>:</td><td>{stats.n}</td>
                <td>KKM</td><td>:</td><td>{kkm}</td>
              </tr>
            </tbody>
          </table>
        </>
      ) : (
        <div style={{ fontSize: 12, borderBottom: "1px solid #000000", paddingBottom: 6, marginBottom: 12 }}>
          {meta.schoolName} — Laporan Hasil Koreksi LJK {meta.subject} {meta.className} (lanjutan)
        </div>
      )}

      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 36 }} /><col /><col style={{ width: 52 }} /><col style={{ width: 52 }} />
            <col style={{ width: 52 }} /><col style={{ width: 56 }} /><col style={{ width: 96 }} />
          </colgroup>
          <thead>
            <tr>
              <th style={th}>No</th><th style={th}>Nama Siswa</th><th style={th}>Benar</th>
              <th style={th}>Salah</th><th style={th}>Kosong</th><th style={th}>Nilai</th><th style={th}>Keterangan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td style={td}>{startIndex + i + 1}</td>
                <td style={{ ...td, textAlign: "left" }}>{r.name || "(tanpa nama)"}</td>
                <td style={td}>{r.correct}</td>
                <td style={td}>{r.wrong}</td>
                <td style={td}>{r.blank}</td>
                <td style={{ ...td, fontWeight: 700 }}>{r.score}</td>
                <td style={td}>{r.score >= kkm ? "Tuntas" : "Belum tuntas"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {footer && (
        <div style={{ marginTop: 24 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: 28 }}>
            <tbody>
              {[
                ["Rata-rata nilai", stats.avg],
                ["Nilai tertinggi", stats.max],
                ["Nilai terendah", stats.min],
                ["Siswa tuntas", `${stats.pass} dari ${stats.n}`],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: "1px 0", width: 130 }}>{k}</td><td style={{ width: 12 }}>:</td><td style={{ fontWeight: 700 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <div style={{ textAlign: "center", width: 260 }}>
              <div>Mengetahui,</div>
              <div>Kepala Sekolah</div>
              <div style={{ height: 70 }} />
              <div style={{ fontWeight: 700, textDecoration: "underline" }}>{meta.principal}</div>
              {meta.principalNip && <div>NIP. {meta.principalNip}</div>}
            </div>
            <div style={{ textAlign: "center", width: 260 }}>
              <div>{meta.city}, {fmtDate(meta.date)}</div>
              <div>Guru Mata Pelajaran</div>
              <div style={{ height: 70 }} />
              <div style={{ fontWeight: 700, textDecoration: "underline" }}>{meta.teacher}</div>
              {meta.teacherNip && <div>NIP. {meta.teacherNip}</div>}
            </div>
          </div>
        </div>
      )}

      <div style={{ position: "absolute", bottom: 24, left: 0, right: 0, textAlign: "center", fontSize: 10, color: "#6b7280" }}>
        Halaman {pageNo} dari {pageCount}
      </div>
    </div>
  );
}

/* ───────────────────────── Template LJK: geometri bersama (preview SVG & PDF vektor) ───────────────────────── */

// Satu sumber geometri dipakai dua kali: preview web (SVG) dan berkas PDF (jsPDF, vektor).
// Dengan begitu isi PDF identik dengan preview dan tidak lagi melewati html2canvas.
const LJK = {
  PAD_T: 40, PAD_BOT: 46, PAD_X: 40,
  H_ID: 84, H_KOP: 92, H_TITLE: 66, H_INFO: 44, H_NOTE: 30, ID_W: 368,
  PER_BLOCK: 10, MAX_PER_ROW: 4,
  HEAD_H: 24, NUMW: 32, FOOT_GAP: 6, FOOT_H: 22, GAP_X: 12, GAP_Y: 14,
};
const LJK_NOTE =
  "Petunjuk: pilih satu jawaban untuk setiap nomor dengan menghitamkan bulatan atau memberi tanda silang (X). " +
  "Gunakan pensil 2B atau pulpen hitam, dan jangan melipat lembar ini.";
// Pusat visual huruf kapital & angka Arial ≈ 0.358em di atas garis dasar.
const midBase = (cy, size) => cy + size * 0.358;
// Garis dasar teks pada kotak baris (top, tinggi baris, ukuran font) — meniru tata letak CSS.
const lineBase = (top, lh, fs) => top + (lh - 1.117 * fs) / 2 + 0.905 * fs;

function ljkGridAvail() {
  const { PAD_T, PAD_BOT, H_ID, H_KOP, H_TITLE, H_INFO, H_NOTE } = LJK;
  return PAGE_H - PAD_T - PAD_BOT - (H_ID + H_KOP + H_TITLE + H_INFO + H_NOTE) - (10 + 12 + 8 + 6 + 8);
}

// Kotak pilihan ganda berbentuk tabel: tiap blok 10 nomor, baris judul A–E, garis sel, bulatan berhuruf,
// dan deretan kotak A–E terpisah di bawah blok (seperti box_pilihan.png).
function ljkGrid(totalQ) {
  const { PER_BLOCK, MAX_PER_ROW, HEAD_H, NUMW, FOOT_GAP, FOOT_H, GAP_X, GAP_Y, PAD_X } = LJK;
  const M = 1; // ruang untuk setengah tebal garis tepi
  const GW = PAGE_W - 2 * PAD_X;
  const nBlocks = Math.ceil(totalQ / PER_BLOCK);
  const nBands = Math.ceil(nBlocks / MAX_PER_ROW);
  const blockW = (GW - 2 * M - (MAX_PER_ROW - 1) * GAP_X) / MAX_PER_ROW;
  const cellW = (blockW - NUMW) / 5;
  const overhead = HEAD_H + FOOT_GAP + FOOT_H;
  const rowH = Math.max(15, Math.min(44, Math.floor((ljkGridAvail() - 2 * M - nBands * overhead - (nBands - 1) * GAP_Y) / (nBands * PER_BLOCK))));
  const b = Math.max(10, Math.min(24, Math.round(cellW - 6), rowH - 8)); // diameter bulatan
  const fs = Math.round(b * 0.5 * 10) / 10;
  const bandH = overhead + PER_BLOCK * rowH;
  const H = M * 2 + nBands * bandH + (nBands - 1) * GAP_Y;
  const THIN = 0.8, THICK = 1.8;
  const P = [];
  const line = (x1, y1, x2, y2, sw) => P.push({ k: "line", x1, y1, x2, y2, sw });
  const text = (x, y, s, size, bold, anchor, color) => P.push({ k: "text", x, y, s, size, bold, anchor, color: color || "#000000" });

  for (let bi = 0; bi < nBlocks; bi++) {
    const band = Math.floor(bi / MAX_PER_ROW), col = bi % MAX_PER_ROW;
    const inBand = band === nBands - 1 ? nBlocks - band * MAX_PER_ROW : MAX_PER_ROW;
    const bandW = inBand * blockW + (inBand - 1) * GAP_X;
    const x = M + (GW - 2 * M - bandW) / 2 + col * (blockW + GAP_X);
    const y = M + band * (bandH + GAP_Y);
    const start = bi * PER_BLOCK;
    const rows = Math.min(PER_BLOCK, totalQ - start);
    const bh = HEAD_H + rows * rowH;

    // garis sel (tipis)
    for (let r = 0; r < rows; r++) line(x, y + HEAD_H + r * rowH, x + blockW, y + HEAD_H + r * rowH, THIN);
    for (let i = 0; i < 5; i++) line(x + NUMW + i * cellW, y, x + NUMW + i * cellW, y + bh, THIN);
    // bingkai luar (tebal)
    P.push({ k: "rect", x, y, w: blockW, h: bh, sw: THICK });

    // judul A–E
    LETTERS.forEach((l, i) => text(x + NUMW + (i + 0.5) * cellW, midBase(y + HEAD_H / 2, 12), l, 12, true, "middle"));

    // baris soal
    for (let r = 0; r < rows; r++) {
      const n = start + r + 1;
      const cy = y + HEAD_H + r * rowH + rowH / 2;
      text(x + NUMW - 6, midBase(cy, 12.5), `${n}.`, 12.5, true, "end");
      LETTERS.forEach((l, i) => {
        const cx = x + NUMW + (i + 0.5) * cellW;
        P.push({ k: "circle", cx, cy, r: (b - 1.4) / 2, sw: 1.4 });
        text(cx, midBase(cy, fs), l, fs, false, "middle", "#6b7280");
      });
    }

    // deretan kotak A–E terpisah di bawah blok
    const fy = y + bh + FOOT_GAP;
    LETTERS.forEach((l, i) => {
      const fx = x + NUMW + i * cellW;
      P.push({ k: "rect", x: fx, y: fy, w: cellW, h: FOOT_H, sw: 1.2 });
      text(fx + cellW / 2, midBase(fy + FOOT_H / 2, 12), l, 12, true, "middle");
    });
  }
  return { w: GW, h: H, prims: P };
}

function ljkIdPrims(schoolName) {
  const school = String(schoolName || "").toUpperCase();
  const rh = (LJK.H_ID - 2) / 3; // tiga baris dengan tinggi sama
  const rows = [["No. Peserta", "", 1, rh], ["Nama", "", 1 + rh, rh], ["Sekolah", school, 1 + 2 * rh, rh]];
  const P = [
    { k: "rect", x: 1, y: 1, w: LJK.ID_W - 2, h: LJK.H_ID - 2, sw: 1.5 },
    { k: "line", x1: 106, y1: 1, x2: 106, y2: LJK.H_ID - 1, sw: 1.5 },
  ];
  const valSize = Math.min(12, (LJK.ID_W - 106 - 16) / Math.max(1, school.length * 0.66));
  rows.forEach(([k, v, top, h], i) => {
    const cy = top + h / 2;
    if (i > 0) P.push({ k: "line", x1: 1, y1: top, x2: LJK.ID_W - 1, y2: top, sw: 1.5 });
    P.push({ k: "text", x: 9, y: midBase(cy, 13), s: k, size: 13, bold: true, anchor: "start", color: "#000000" });
    if (v) P.push({ k: "text", x: 114, y: midBase(cy, valSize), s: v, size: valSize, bold: false, anchor: "start", color: "#000000" });
  });
  return P;
}

function SvgPrims({ prims }) {
  const FONT = "Arial, Helvetica, sans-serif";
  return (
    <>
      {prims.map((p, i) => {
        if (p.k === "line") return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke="#000000" strokeWidth={p.sw} />;
        if (p.k === "rect") return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill="none" stroke="#000000" strokeWidth={p.sw} />;
        if (p.k === "circle") return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill="none" stroke="#000000" strokeWidth={p.sw} />;
        return (
          <text key={i} x={p.x} y={p.y} textAnchor={p.anchor} fontFamily={FONT} fontSize={p.size} fontWeight={p.bold ? 700 : 400} fill={p.color}>
            {p.s}
          </text>
        );
      })}
    </>
  );
}

function LjkTemplate({ meta, totalQ, logoL, logoR }) {
  const FONT = "Arial, Helvetica, sans-serif";
  const { PAD_T, PAD_BOT, PAD_X, H_ID, H_KOP, H_TITLE, H_INFO, H_NOTE, ID_W } = LJK;
  const grid = ljkGrid(totalQ);
  const corner = (pos) => <div style={{ position: "absolute", width: 18, height: 18, background: "#000000", ...pos }} />;

  return (
    <div
      data-page
      style={{
        width: PAGE_W, height: PAGE_H, boxSizing: "border-box", padding: `${PAD_T}px ${PAD_X}px ${PAD_BOT}px`, background: "#ffffff",
        color: "#000000", fontFamily: FONT, position: "relative", overflow: "hidden",
      }}
    >
      {corner({ top: 16, left: 16 })}
      {corner({ top: 16, right: 16 })}
      {corner({ bottom: 16, left: 16 })}
      {corner({ bottom: 16, right: 16 })}

      {/* Kotak identitas siswa (kanan atas) */}
      <div style={{ display: "flex", justifyContent: "flex-end", height: H_ID }}>
        <svg width={ID_W} height={H_ID} viewBox={`0 0 ${ID_W} ${H_ID}`} xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
          <SvgPrims prims={ljkIdPrims(meta.schoolName)} />
        </svg>
      </div>

      <div style={{ marginTop: 10, minHeight: H_KOP }}>
        <Kop meta={meta} logoL={logoL} logoR={logoR} />
      </div>

      {/* Judul */}
      <div style={{ marginTop: 12, height: H_TITLE, textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: "28px" }}>LEMBAR JAWAB</div>
        {meta.examTitle && <div style={{ fontSize: 14, fontWeight: 700, lineHeight: "18px" }}>{String(meta.examTitle).toUpperCase()}</div>}
        {meta.tahunAjaran && <div style={{ fontSize: 13, lineHeight: "17px" }}>TAHUN AJARAN {meta.tahunAjaran}</div>}
      </div>

      {/* Mata pelajaran & kelas */}
      <div style={{ marginTop: 8, height: H_INFO, marginLeft: 140, fontSize: 13 }}>
        {[["Mata Pelajaran", meta.subject], ["Kelas", meta.className]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", height: 22, lineHeight: "22px" }}>
            <div style={{ width: 120, fontWeight: 700 }}>{k}</div>
            <div style={{ width: 16, fontWeight: 700 }}>:</div>
            <div>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 6, height: H_NOTE, fontSize: 10.5, lineHeight: "15px" }}>{LJK_NOTE}</div>

      <div style={{ marginTop: 8 }}>
        <svg width={grid.w} height={grid.h} viewBox={`0 0 ${grid.w} ${grid.h}`} xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
          <SvgPrims prims={grid.prims} />
        </svg>
      </div>
    </div>
  );
}

/* PDF vektor untuk template LJK (tajam, tanpa html2canvas, posisi teks presisi) */
function buildLjkPdf({ meta, totalQ, logoL, logoR }) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const S = doc.internal.pageSize.getWidth() / PAGE_W; // pt per px
  const px = (v) => v * S;
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const { PAD_T, PAD_X, H_ID, H_KOP, H_TITLE, H_INFO, H_NOTE, ID_W } = LJK;

  const drawPrims = (prims, ox, oy) => {
    doc.setDrawColor(0, 0, 0);
    prims.forEach((p) => {
      if (p.k === "text") {
        doc.setFont("helvetica", p.bold ? "bold" : "normal");
        doc.setFontSize(px(p.size));
        doc.setTextColor(...rgb(p.color));
        doc.text(String(p.s), px(ox + p.x), px(oy + p.y), { align: p.anchor === "middle" ? "center" : p.anchor === "end" ? "right" : "left" });
        return;
      }
      doc.setLineWidth(px(p.sw));
      if (p.k === "line") doc.line(px(ox + p.x1), px(oy + p.y1), px(ox + p.x2), px(oy + p.y2));
      else if (p.k === "rect") doc.rect(px(ox + p.x), px(oy + p.y), px(p.w), px(p.h), "S");
      else if (p.k === "circle") doc.circle(px(ox + p.cx), px(oy + p.cy), px(p.r), "S");
    });
  };
  const put = (s, x, baseY, size, { bold = false, font = "helvetica", style, align = "left" } = {}) => {
    doc.setFont(font, style || (bold ? "bold" : "normal"));
    doc.setFontSize(px(size));
    doc.setTextColor(0, 0, 0);
    doc.text(String(s), px(x), px(baseY), { align });
  };

  // penanda sudut
  doc.setFillColor(0, 0, 0);
  [[16, 16], [PAGE_W - 34, 16], [16, PAGE_H - 34], [PAGE_W - 34, PAGE_H - 34]].forEach(([x, y]) => doc.rect(px(x), px(y), px(18), px(18), "F"));

  // kotak identitas
  drawPrims(ljkIdPrims(meta.schoolName), PAGE_W - PAD_X - ID_W, PAD_T);

  // kop surat
  const kopTop = PAD_T + H_ID + 10;
  const BOX = 80;
  const lines = String(meta.instansi || "").split("\n").map((s) => s.trim()).filter(Boolean).map((t) => t.toUpperCase());
  lines.push(String(meta.schoolName || "").toUpperCase());
  const hasAddr = !!meta.address;
  const textH = lines.length * 20 + (hasAddr ? 14 : 0);
  const rowH = Math.max(BOX, textH);
  const textW = PAGE_W - 2 * PAD_X - 2 * (BOX + 12);
  let ty = kopTop + (rowH - textH) / 2;
  lines.forEach((t) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(px(15));
    const w = doc.getTextWidth(t) / S;
    const size = w > textW ? (15 * textW) / w : 15;
    put(t, PAGE_W / 2, lineBase(ty, 20, size), size, { bold: true, align: "center" });
    ty += 20;
  });
  if (hasAddr) {
    doc.setFont("times", "italic");
    doc.setFontSize(px(11));
    const w = doc.getTextWidth(meta.address) / S;
    const size = w > textW ? (11 * textW) / w : 11;
    put(meta.address, PAGE_W / 2, lineBase(ty, 14, size), size, { font: "times", style: "italic", align: "center" });
  }
  [[logoL, PAD_X], [logoR, PAGE_W - PAD_X - BOX]].forEach(([l, bx]) => {
    const f = fitBox(l, BOX);
    if (!f) return;
    try {
      doc.addImage(l.src, "PNG", px(bx + (BOX - f.w) / 2), px(kopTop + (rowH - f.h) / 2), px(f.w), px(f.h));
    } catch {
      /* logo gagal disematkan: lewati */
    }
  });
  doc.setFillColor(0, 0, 0);
  doc.rect(px(PAD_X), px(kopTop + rowH + 6), px(PAGE_W - 2 * PAD_X), px(3), "F");
  doc.rect(px(PAD_X), px(kopTop + rowH + 11), px(PAGE_W - 2 * PAD_X), px(1), "F");

  // judul
  const titleTop = kopTop + Math.max(H_KOP, rowH + 12) + 12;
  let y = titleTop;
  put("LEMBAR JAWAB", PAGE_W / 2, lineBase(y, 28, 22), 22, { bold: true, align: "center" });
  y += 28;
  if (meta.examTitle) {
    put(String(meta.examTitle).toUpperCase(), PAGE_W / 2, lineBase(y, 18, 14), 14, { bold: true, align: "center" });
    y += 18;
  }
  if (meta.tahunAjaran) put(`TAHUN AJARAN ${meta.tahunAjaran}`, PAGE_W / 2, lineBase(y, 17, 13), 13, { align: "center" });

  // mata pelajaran & kelas
  const infoTop = titleTop + H_TITLE + 8;
  [["Mata Pelajaran", meta.subject], ["Kelas", meta.className]].forEach(([k, v], i) => {
    const base = lineBase(infoTop + i * 22, 22, 13);
    put(k, PAD_X + 140, base, 13, { bold: true });
    put(":", PAD_X + 140 + 120, base, 13, { bold: true });
    put(v || "", PAD_X + 140 + 136, base, 13);
  });

  // petunjuk
  const noteTop = infoTop + H_INFO + 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(px(10.5));
  doc.splitTextToSize(LJK_NOTE, px(PAGE_W - 2 * PAD_X)).forEach((ln, i) => put(ln, PAD_X, lineBase(noteTop + i * 15, 15, 10.5), 10.5));

  // kotak pilihan ganda
  drawPrims(ljkGrid(totalQ).prims, PAD_X, noteTop + H_NOTE + 8);
  return doc;
}

/* ───────────────────────── Aplikasi utama ───────────────────────── */

const TABS = [
  { id: "pengaturan", label: "Pengaturan", icon: Settings },
  { id: "kunci", label: "Kunci Jawaban", icon: KeyRound },
  { id: "koreksi", label: "Koreksi", icon: ScanLine },
  { id: "hasil", label: "Hasil", icon: Table2 },
  { id: "template", label: "Template LJK", icon: FileText },
];

export default function App() {
  const saved = useMemo(loadSaved, []);
  const [settings, setSettings] = useState(() => {
    const merged = { ...DEFAULT_SETTINGS, ...(saved?.settings || {}), date: today() };
    if (merged.model === "gemini-2.5-flash") merged.model = DEFAULT_SETTINGS.model;
    return merged;
  });
  const [answerKey, setAnswerKey] = useState(() => {
    const n = saved?.settings?.totalQ || DEFAULT_SETTINGS.totalQ;
    return Array.from({ length: n }, (_, i) => normLetter(saved?.answerKey?.[i]));
  });
  const [logoL, setLogoL] = useState(saved?.logoL || null);
  const [logoR, setLogoR] = useState(saved?.logoR || null);
  const [tab, setTab] = useState("pengaturan");
  const [showKey, setShowKey] = useState(false);
  const [students, setStudents] = useState([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [sort, setSort] = useState("masuk");
  const [expanded, setExpanded] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [bulk, setBulk] = useState("");
  const [qInput, setQInput] = useState(String(settings.totalQ));
  const [models, setModels] = useState([]);
  const [keyStatus, setKeyStatus] = useState({ state: "idle", msg: "" });

  const filesRef = useRef(new Map());
  const runningRef = useRef(false);
  const reportRef = useRef(null);
  const lastChecked = useRef("");

  const totalQ = settings.totalQ;
  const kkm = Number(settings.kkm) || 0;
  const set = (k, v) => setSettings((p) => ({ ...p, [k]: v }));

  /* ── cek API key & deteksi model ── */
  const checkKey = async () => {
    if (!settings.apiKey.trim()) return setKeyStatus({ state: "error", msg: "Isi API key terlebih dahulu." });
    setKeyStatus({ state: "checking", msg: "" });
    try {
      const list = await listModels(settings.apiKey);
      if (!list.length) throw new Error("API key valid, tetapi tidak ada model Gemini yang mendukung generateContent.");
      setModels(list);
      const best = pickBestModel(list);
      const stillValid = list.some((m) => m.id === settings.model);
      if (settings.autoModel || !stillValid) set("model", best);
      setKeyStatus({
        state: "ok",
        msg: `API key valid. ${list.length} model tersedia${settings.autoModel || !stillValid ? `, terpilih: ${best}` : ""}.`,
      });
    } catch (e) {
      setModels([]);
      setKeyStatus({ state: "error", msg: e.message || "API key tidak dapat diperiksa." });
    }
  };

  useEffect(() => {
    if (settings.apiKey.trim()) {
      lastChecked.current = settings.apiKey;
      checkKey();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ settings: settings.remember ? settings : { ...settings, apiKey: "" }, answerKey, logoL, logoR })
      );
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
  }, [settings, answerKey, logoL, logoR]);

  /* ── kunci jawaban ── */
  const changeTotal = (v) => {
    const n = Math.max(1, Math.min(100, Math.round(Number(v)) || 1));
    set("totalQ", n);
    setAnswerKey((p) => Array.from({ length: n }, (_, i) => p[i] || ""));
    setQInput(String(n));
  };
  const setKeyAt = (i, letter) => setAnswerKey((p) => p.map((k, idx) => (idx === i ? (k === letter ? "" : letter) : k)));
  const applyBulk = () => {
    const letters = bulk.toUpperCase().replace(/[^A-E]/g, "").split("").slice(0, 100);
    if (!letters.length) return setNotice("Tidak ada huruf A–E yang terbaca. Contoh: ABCDEABCDE");
    set("totalQ", letters.length);
    setQInput(String(letters.length));
    setAnswerKey(letters);
    setBulk("");
  };
  const keyFilled = answerKey.filter(Boolean).length;

  /* ── unggah & koreksi ── */
  const addFiles = (list) => {
    const items = [...list]
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => {
        const id = uid();
        filesRef.current.set(id, f);
        return { id, fileName: f.name, preview: URL.createObjectURL(f), name: "", answers: {}, status: "menunggu", error: "" };
      });
    if (!items.length) return setNotice("Pilih berkas gambar (JPG, PNG, atau WebP).");
    setStudents((p) => [...p, ...items]);
  };
  const update = (id, patch) => setStudents((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const setAnswer = (id, no, v) =>
    setStudents((p) => p.map((s) => (s.id === id ? { ...s, answers: { ...s.answers, [no]: v } } : s)));
  const removeStudent = (id) => {
    const s = students.find((x) => x.id === id);
    if (s) URL.revokeObjectURL(s.preview);
    filesRef.current.delete(id);
    setStudents((p) => p.filter((x) => x.id !== id));
  };
  const clearAll = () => {
    students.forEach((s) => URL.revokeObjectURL(s.preview));
    filesRef.current.clear();
    setStudents([]);
  };

  const processAll = async (onlyId) => {
    if (runningRef.current) return;
    if (!settings.apiKey.trim()) {
      setNotice("Masukkan API key Gemini terlebih dahulu di tab Pengaturan.");
      setTab("pengaturan");
      return;
    }
    const targets = students
      .filter((s) => (onlyId ? s.id === onlyId : s.status === "menunggu" || s.status === "gagal"))
      .map((s) => s.id);
    if (!targets.length) return;
    runningRef.current = true;
    setRunning(true);
    for (const id of targets) {
      update(id, { status: "memproses", error: "" });
      try {
        const base64 = await prepareImage(filesRef.current.get(id));
        const result = await callGemini({ apiKey: settings.apiKey, model: settings.model, base64, totalQ });
        update(id, { status: "selesai", name: result.name, answers: result.answers });
      } catch (e) {
        update(id, { status: "gagal", error: e.message || "Terjadi kesalahan." });
      }
    }
    runningRef.current = false;
    setRunning(false);
  };

  /* ── hasil ── */
  const graded = useMemo(
    () => students.filter((s) => s.status === "selesai").map((s) => ({ ...s, ...grade(s, answerKey) })),
    [students, answerKey]
  );
  const sorted = useMemo(() => {
    const a = [...graded];
    if (sort === "nama") a.sort((x, y) => x.name.localeCompare(y.name, "id"));
    if (sort === "nilai") a.sort((x, y) => y.score - x.score);
    return a;
  }, [graded, sort]);
  const stats = useMemo(() => {
    const n = graded.length;
    if (!n) return { n: 0, avg: 0, max: 0, min: 0, pass: 0 };
    const sc = graded.map((g) => g.score);
    return {
      n,
      avg: Math.round((sc.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      max: Math.max(...sc),
      min: Math.min(...sc),
      pass: sc.filter((v) => v >= kkm).length,
    };
  }, [graded, kkm]);

  const reportPages = useMemo(() => paginate(sorted), [sorted]);
  const renderReport = (wrap) => {
    let start = 0;
    return reportPages.map((p, i) => {
      const el = (
        <ReportPage
          key={i} meta={settings} logoL={logoL} logoR={logoR} rows={p.rows} startIndex={start} pageNo={i + 1}
          pageCount={reportPages.length} first={i === 0} footer={p.footer} stats={stats} kkm={kkm} totalQ={totalQ}
        />
      );
      start += p.rows.length;
      return wrap ? <ScaledPage key={i}>{el}</ScaledPage> : el;
    });
  };

  const exportReport = async () => {
    if (!sorted.length || !reportRef.current) return;
    setBusy("laporan");
    try {
      await sleep(50);
      const els = [...reportRef.current.querySelectorAll("[data-page]")];
      await exportPagesToPdf(els, `Laporan-${slug(settings.subject)}-${slug(settings.className)}.pdf`);
    } catch (e) {
      setNotice("Gagal membuat PDF: " + (e.message || e));
    } finally {
      setBusy("");
    }
  };

  const exportTemplate = async () => {
    setBusy("template");
    try {
      await sleep(30);
      buildLjkPdf({ meta: settings, totalQ, logoL, logoR }).save(`Template-LJK-${totalQ}-soal.pdf`);
    } catch (e) {
      setNotice("Gagal membuat PDF: " + (e.message || e));
    } finally {
      setBusy("");
    }
  };

  const printTemplate = () => {
    const w = window.open("", "_blank");
    if (!w) {
      setNotice("Jendela cetak diblokir browser. Gunakan tombol Unduh PDF lalu cetak dari berkas tersebut.");
      return;
    }
    setBusy("print");
    try {
      const doc = buildLjkPdf({ meta: settings, totalQ, logoL, logoR });
      doc.autoPrint();
      w.location.href = doc.output("bloburl");
    } catch (e) {
      w.close();
      setNotice("Gagal menyiapkan cetak: " + (e.message || e));
    } finally {
      setBusy("");
    }
  };

  const onLogo = (side, file) => {
    if (!file) return;
    const setter = side === "L" ? setLogoL : setLogoR;
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const nw = img.naturalWidth || 300;
        const nh = img.naturalHeight || 300;
        const sc = Math.min(1, 300 / Math.max(nw, nh));
        const w = Math.max(1, Math.round(nw * sc));
        const h = Math.max(1, Math.round(nh * sc));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        setter({ src: c.toDataURL("image/png"), w, h });
      };
      img.src = String(r.result);
    };
    r.readAsDataURL(file);
  };

  const pending = students.filter((s) => s.status === "menunggu" || s.status === "gagal").length;
  const keyWarning = keyFilled < totalQ && (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Kunci jawaban baru terisi {keyFilled} dari {totalQ} soal. Soal tanpa kunci tidak ikut dihitung dalam skor.
      </span>
    </div>
  );

  /* ───────── render ───────── */
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <div className="rounded-lg bg-indigo-600 p-2 text-white">
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight text-slate-900">AI Grader Sistem</h1>
            <p className="text-xs text-slate-500">Koreksi LJK otomatis untuk sekolah menengah</p>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2" aria-label="Menu utama">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        {notice && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Tutup pesan" className="rounded p-0.5 hover:bg-rose-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ── PENGATURAN ── */}
        {tab === "pengaturan" && (
          <>
            <Card title="Gemini Vision API" icon={KeyRound}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="API key Gemini" hint="Dibuat gratis di Google AI Studio. Dikirim langsung dari browser ke Google, tanpa server perantara.">
                  <div className="flex gap-2">
                    <input
                      type={showKey ? "text" : "password"} value={settings.apiKey} autoComplete="off"
                      onChange={(e) => set("apiKey", e.target.value)} className={inputCls} placeholder="AIza…"
                      onBlur={() => {
                        if (settings.apiKey.trim() && lastChecked.current !== settings.apiKey) {
                          lastChecked.current = settings.apiKey;
                          checkKey();
                        }
                      }}
                    />
                    <button type="button" onClick={() => setShowKey((v) => !v)} className={btnGhost} aria-label={showKey ? "Sembunyikan API key" : "Tampilkan API key"}>
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
                <Field label="Model" hint="Harus mendukung input gambar. Bawaan: Gemini 3.5 Flash-Lite (gemini-3.5-flash-lite).">
                  {models.length > 0 ? (
                    <select
                      value={settings.model}
                      onChange={(e) => {
                        set("model", e.target.value);
                        set("autoModel", false);
                      }}
                      className={inputCls}
                    >
                      {!models.some((m) => m.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.label} ({m.id})</option>
                      ))}
                    </select>
                  ) : (
                    <input value={settings.model} onChange={(e) => set("model", e.target.value)} className={inputCls} />
                  )}
                </Field>
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => {
                      lastChecked.current = settings.apiKey;
                      checkKey();
                    }}
                    disabled={keyStatus.state === "checking"}
                    className={btnPrimary}
                  >
                    {keyStatus.state === "checking" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Cek API key &amp; deteksi model
                  </button>
                  {keyStatus.msg && (
                    <span className={`text-sm ${keyStatus.state === "ok" ? "text-emerald-700" : "text-rose-700"}`} role="status">
                      {keyStatus.msg}
                    </span>
                  )}
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={settings.autoModel} onChange={(e) => set("autoModel", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                Pilih otomatis model Flash-Lite terbaru saat API key dicek
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={settings.remember} onChange={(e) => set("remember", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                Ingat API key di perangkat ini (jangan aktifkan di komputer bersama)
              </label>
            </Card>

            <Card title="Identitas sekolah & ujian" icon={GraduationCap}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Instansi / kop atas (opsional)" hint="Satu baris per baris kop, mis. nama pemerintah daerah lalu nama dinas pendidikan.">
                    <textarea rows={2} value={settings.instansi} onChange={(e) => set("instansi", e.target.value)} className={inputCls} />
                  </Field>
                </div>
                <Field label="Nama sekolah">
                  <input value={settings.schoolName} onChange={(e) => set("schoolName", e.target.value)} className={inputCls} />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Alamat sekolah">
                    <input value={settings.address} onChange={(e) => set("address", e.target.value)} className={inputCls} />
                  </Field>
                </div>
                <Field label="Nama ujian">
                  <input value={settings.examTitle} onChange={(e) => set("examTitle", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Tahun ajaran" hint="Tampil di judul LJK, mis. 2026/2027.">
                  <input value={settings.tahunAjaran} onChange={(e) => set("tahunAjaran", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Mata pelajaran">
                  <input value={settings.subject} onChange={(e) => set("subject", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Kelas">
                  <input value={settings.className} onChange={(e) => set("className", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Tanggal">
                  <input type="date" value={settings.date} onChange={(e) => set("date", e.target.value)} className={inputCls} />
                </Field>
                <Field label="KKM" hint="Nilai minimal untuk dinyatakan tuntas.">
                  <input type="number" min="0" max="100" value={settings.kkm} onChange={(e) => set("kkm", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Kota (untuk tanda tangan)">
                  <input value={settings.city} onChange={(e) => set("city", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Nama guru">
                  <input value={settings.teacher} onChange={(e) => set("teacher", e.target.value)} className={inputCls} />
                </Field>
                <Field label="NIP guru (opsional)">
                  <input value={settings.teacherNip} onChange={(e) => set("teacherNip", e.target.value)} className={inputCls} />
                </Field>
                <Field label="Nama kepala sekolah">
                  <input value={settings.principal} onChange={(e) => set("principal", e.target.value)} className={inputCls} />
                </Field>
                <Field label="NIP kepala sekolah (opsional)">
                  <input value={settings.principalNip} onChange={(e) => set("principalNip", e.target.value)} className={inputCls} />
                </Field>
                <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
                  {[
                    ["L", "Logo kiri (mis. logo daerah)", logoL, setLogoL],
                    ["R", "Logo kanan (mis. logo sekolah)", logoR, setLogoR],
                  ].map(([side, label, val, setter]) => (
                    <Field key={side} label={label} hint="Tampil di kop LJK dan laporan PDF. Disimpan di browser ini.">
                      <div className="flex items-center gap-3">
                        {val && <img src={val.src} alt={label} className="h-12 w-12 rounded border border-slate-200 object-contain" />}
                        <input
                          type="file" accept="image/*"
                          onChange={(e) => { onLogo(side, e.target.files?.[0]); e.target.value = ""; }}
                          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
                        />
                        {val && (
                          <button type="button" onClick={() => setter(null)} className={btnGhost}>
                            Hapus
                          </button>
                        )}
                      </div>
                    </Field>
                  ))}
                </div>
              </div>
            </Card>
          </>
        )}

        {/* ── KUNCI JAWABAN ── */}
        {tab === "kunci" && (
          <>
            <Card title="Pengaturan kunci" icon={KeyRound}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Jumlah soal (1–100)">
                  <input
                    type="number" min="1" max="100" value={qInput} className={inputCls}
                    onChange={(e) => {
                      setQInput(e.target.value);
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= 1 && n <= 100) changeTotal(n);
                    }}
                    onBlur={() => setQInput(String(totalQ))}
                  />
                </Field>
                <Field label="Tempel kunci sekaligus" hint="Contoh: ABCDEABCDE. Jumlah soal mengikuti panjang kunci.">
                  <div className="flex gap-2">
                    <input value={bulk} onChange={(e) => setBulk(e.target.value)} className={inputCls} placeholder="ABCDE…" />
                    <button type="button" onClick={applyBulk} className={btnGhost}>Terapkan</button>
                  </div>
                </Field>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-slate-600">Terisi {keyFilled} dari {totalQ} soal</span>
                <button type="button" onClick={() => setAnswerKey(Array(totalQ).fill(""))} className={btnGhost}>
                  <RotateCcw className="h-4 w-4" /> Kosongkan kunci
                </button>
              </div>
            </Card>

            <Card title="Pilih jawaban benar">
              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {answerKey.map((k, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <span className="w-8 text-right text-sm font-semibold text-slate-600">{i + 1}</span>
                    <div className="flex gap-1">
                      {LETTERS.map((l) => (
                        <button
                          key={l} type="button" onClick={() => setKeyAt(i, l)} aria-pressed={k === l}
                          aria-label={`Soal ${i + 1} jawaban ${l}`}
                          className={`h-9 w-9 rounded-full border text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                            k === l ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}

        {/* ── KOREKSI ── */}
        {tab === "koreksi" && (
          <>
            {keyWarning}
            <Card
              title="Unggah foto LJK"
              icon={ImagePlus}
              action={
                <div className="flex gap-2">
                  {students.length > 0 && (
                    <button type="button" onClick={clearAll} disabled={running} className={btnGhost}>
                      <Trash2 className="h-4 w-4" /> Hapus semua
                    </button>
                  )}
                  <button type="button" onClick={() => processAll()} disabled={running || !pending} className={btnPrimary}>
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {running ? "Memproses…" : `Mulai koreksi${pending ? ` (${pending})` : ""}`}
                  </button>
                </div>
              }
            >
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }}
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center hover:border-indigo-400 hover:bg-indigo-50"
              >
                <Upload className="h-8 w-8 text-indigo-500" />
                <span className="text-sm font-medium text-slate-700">Ketuk untuk memilih foto atau seret ke sini</span>
                <span className="text-xs text-slate-500">Satu foto untuk satu siswa. Pastikan lembar terlihat utuh, lurus, dan terang.</span>
                <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </label>
            </Card>

            {students.length > 0 && (
              <div className="space-y-2">
                {students.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                    <img src={s.preview} alt={`Foto ${s.fileName}`} className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 object-cover" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900">{s.name || s.fileName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <StatusChip status={s.status} />
                        {s.status === "selesai" && (
                          <span className="text-xs text-slate-500">
                            {Object.values(s.answers).filter(Boolean).length} dari {totalQ} nomor terbaca
                          </span>
                        )}
                      </div>
                      {s.error && <div className="mt-1 text-xs text-rose-600">{s.error}</div>}
                    </div>
                    {(s.status === "gagal" || s.status === "selesai") && (
                      <button type="button" disabled={running} onClick={() => processAll(s.id)} className={btnGhost} aria-label="Koreksi ulang">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" disabled={s.status === "memproses"} onClick={() => removeStudent(s.id)} className={btnGhost} aria-label="Hapus foto">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── HASIL ── */}
        {tab === "hasil" && (
          <>
            {keyWarning}
            {graded.length === 0 ? (
              <Card>
                <p className="py-6 text-center text-sm text-slate-500">
                  Belum ada hasil. Unggah foto LJK di tab Koreksi, lalu jalankan koreksi.
                </p>
              </Card>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <StatBox label="Jumlah siswa" value={stats.n} />
                  <StatBox label="Rata-rata" value={stats.avg} />
                  <StatBox label="Tertinggi" value={stats.max} />
                  <StatBox label="Terendah" value={stats.min} />
                  <StatBox label={`Tuntas (KKM ${kkm})`} value={`${stats.pass}/${stats.n}`} />
                </div>

                <Card
                  title="Tabel nilai"
                  icon={Table2}
                  action={
                    <div className="flex items-center gap-2">
                      <select value={sort} onChange={(e) => setSort(e.target.value)} className={`${inputCls} !w-auto`} aria-label="Urutkan">
                        <option value="masuk">Urutan masuk</option>
                        <option value="nama">Nama A–Z</option>
                        <option value="nilai">Nilai tertinggi</option>
                      </select>
                    </div>
                  }
                >
                  <div className="-mx-4 overflow-x-auto sm:mx-0">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                          <th className="px-3 py-2 font-medium">No</th>
                          <th className="px-3 py-2 font-medium">Nama siswa</th>
                          <th className="px-3 py-2 text-center font-medium">Benar</th>
                          <th className="px-3 py-2 text-center font-medium">Salah</th>
                          <th className="px-3 py-2 text-center font-medium">Kosong</th>
                          <th className="px-3 py-2 text-center font-medium">Nilai</th>
                          <th className="px-3 py-2 font-medium">Keterangan</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((r, i) => (
                          <React.Fragment key={r.id}>
                            <tr className="border-b border-slate-100">
                              <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                              <td className="px-3 py-2">
                                <input
                                  value={r.name} onChange={(e) => update(r.id, { name: e.target.value.toUpperCase() })}
                                  placeholder="Isi nama siswa" aria-label={`Nama siswa ${i + 1}`}
                                  className="w-full rounded border border-transparent bg-transparent px-2 py-1 hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus:outline-none"
                                />
                              </td>
                              <td className="px-3 py-2 text-center text-emerald-700">{r.correct}</td>
                              <td className="px-3 py-2 text-center text-rose-700">{r.wrong}</td>
                              <td className="px-3 py-2 text-center text-slate-500">{r.blank}</td>
                              <td className="px-3 py-2 text-center font-semibold text-slate-900">{r.score}</td>
                              <td className="px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.score >= kkm ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                  {r.score >= kkm ? "Tuntas" : "Belum tuntas"}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button" onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                                  aria-expanded={expanded === r.id}
                                >
                                  Detail {expanded === r.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                </button>
                              </td>
                            </tr>
                            {expanded === r.id && (
                              <tr className="border-b border-slate-100 bg-slate-50">
                                <td colSpan={8} className="p-3">
                                  <p className="mb-2 text-xs text-slate-500">
                                    Periksa hasil bacaan AI dan ubah jika ada yang keliru. Hijau benar, merah salah, kuning kosong.
                                  </p>
                                  <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8 lg:grid-cols-10">
                                    {answerKey.map((k, idx) => {
                                      const a = r.answers[idx + 1] || "";
                                      const tone = !k ? "border-slate-200 bg-white" : !a ? "border-amber-300 bg-amber-50" : a === k ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50";
                                      return (
                                        <div key={idx} className={`flex items-center justify-between gap-1 rounded border px-1.5 py-1 ${tone}`}>
                                          <span className="text-xs font-semibold text-slate-600">{idx + 1}</span>
                                          <select
                                            value={a} onChange={(e) => setAnswer(r.id, idx + 1, e.target.value)}
                                            aria-label={`Jawaban nomor ${idx + 1}`}
                                            className="rounded bg-transparent text-sm font-medium focus:outline-none"
                                          >
                                            <option value="">–</option>
                                            {LETTERS.map((l) => <option key={l} value={l}>{l}</option>)}
                                          </select>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <Card
                  title="Laporan PDF resmi"
                  icon={FileDown}
                  action={
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setShowPreview((v) => !v)} className={btnGhost}>
                        {showPreview ? "Tutup pratinjau" : "Pratinjau"}
                      </button>
                      <button type="button" onClick={exportReport} disabled={busy === "laporan"} className={btnPrimary}>
                        {busy === "laporan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        Unduh PDF
                      </button>
                    </div>
                  }
                >
                  <p className="text-sm text-slate-600">
                    Laporan memuat kop sekolah, tabel nilai, ringkasan statistik, dan kolom tanda tangan kepala sekolah serta guru.
                    Ubah identitas di tab Pengaturan.
                  </p>
                  {showPreview && <div className="mt-4 grid gap-4 sm:grid-cols-2">{renderReport(true)}</div>}
                </Card>
              </>
            )}
          </>
        )}

        {/* ── TEMPLATE LJK ── */}
        {tab === "template" && (
          <Card
            title="Template LJK"
            icon={FileText}
            action={
              <div className="flex gap-2">
                <button type="button" onClick={printTemplate} disabled={!!busy} className={btnGhost}>
                  {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                  Cetak
                </button>
                <button type="button" onClick={exportTemplate} disabled={!!busy} className={btnPrimary}>
                  {busy === "template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Unduh PDF
                </button>
              </div>
            }
          >
            <p className="mb-4 text-sm text-slate-600">
              Lembar A4 dengan {totalQ} nomor (A–E) dalam kotak tabel berisi 10 soal per blok. Jumlah soal, kop, logo, judul, mata pelajaran, dan kelas
              mengikuti isian di tab Kunci Jawaban dan Pengaturan. Cetak dengan skala 100% agar hasil foto mudah dibaca AI.
            </p>
            <div className="mx-auto max-w-md">
              <ScaledPage>
                <LjkTemplate meta={settings} totalQ={totalQ} logoL={logoL} logoR={logoR} />
              </ScaledPage>
            </div>
          </Card>
        )}
      </main>

      {/* Salinan ukuran penuh untuk ditangkap html2canvas (tersembunyi di belakang halaman) */}
      <div aria-hidden="true" style={{ position: "fixed", top: 0, left: 0, zIndex: -1, pointerEvents: "none" }}>
        <div ref={reportRef}>{sorted.length > 0 && renderReport(false)}</div>
      </div>
    </div>
  );
}
