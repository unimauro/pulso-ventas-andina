// Analista Andina — agente de chat (Vercel Serverless Function, Node 18+)
// Usa OpenRouter (LLM_API_KEY, LLM_MODEL) y una herramienta `resumen_ventas`
// que consulta la API real /api/resumen. NUNCA inventa cifras: toda cifra sale
// de la herramienta, y se devuelve al cliente exactamente qué se consultó.

const RESUMEN_BASE = process.env.RESUMEN_URL || "https://andina-pulso.vercel.app/api/resumen";
const OPENROUTER   = "https://openrouter.ai/api/v1/chat/completions";
const MODEL        = process.env.LLM_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";
const MAX_STEPS    = 4;

const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Set","Oct","Nov","Dic"];
const REGIONES = ["Lima","Norte","Centro","Sur"];
const CANALES  = ["Tienda","Mayorista","WhatsApp","Online"];
const VENDEDORES = ["Ana Quispe","Jorge Huamán","Luis Paredes","María Torres","Rodrigo Salas","Rosa Ccori"];

const SYSTEM = `Eres «Analista Andina», un analista de ventas de Distribuidora Andina (empresa ficticia, datos 2025, montos en soles S/).

REGLA DE ORO: NUNCA inventes, estimes ni redondees cifras de memoria. Toda cifra (ventas, margen, pedidos, vencido, rankings por mes/región/canal/producto) DEBE provenir de la herramienta resumen_ventas. Si no tienes el dato, llama a la herramienta. Si la herramienta no lo ofrece, dilo con claridad en vez de inventar.

HERRAMIENTA disponible:
- resumen_ventas(mes?, region?, canal?, vendedor?): devuelve el resumen filtrado de la API real. Campos: ventas, margen, vencido, pedidos, ventasPorMes[], ventasPorRegion[], ventasPorCanal[], top5Productos[]. Filtros válidos:
  · mes: número 1..12 (o nada = todo el año)
  · region: ${REGIONES.join(", ")}
  · canal: ${CANALES.join(", ")}
  · vendedor: ${VENDEDORES.join(", ")}
  (La herramienta NO expone descuentos por vendedor ni categorías; no inventes eso.)

PROTOCOLO: responde SIEMPRE con UN ÚNICO objeto JSON, sin texto alrededor, en una de estas dos formas:
1) Para consultar datos:
   {"accion":"resumen_ventas","filtros":{"mes":12,"region":"Lima"},"motivo":"breve"}
   (incluye sólo los filtros que apliquen; usa null u omite los que no)
2) Para la respuesta final al usuario:
   {"accion":"final","respuesta":"texto claro en español, citando las cifras obtenidas con S/ y separador de miles"}

Puedes encadenar varias consultas (una por turno) antes de la respuesta final. Sé conciso, cálido y profesional. En la respuesta final, menciona explícitamente el filtro usado (p. ej. «en Lima, diciembre»).`;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- herramienta real: llama a /api/resumen ---
async function resumenVentas(filtros = {}) {
  const qs = new URLSearchParams();
  if (filtros.mes != null && filtros.mes !== "") qs.set("mes", String(filtros.mes));
  if (filtros.region) qs.set("region", filtros.region);
  if (filtros.canal) qs.set("canal", filtros.canal);
  if (filtros.vendedor) qs.set("vendedor", filtros.vendedor);
  const url = RESUMEN_BASE + (qs.toString() ? "?" + qs : "");
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("resumen " + r.status);
  const data = await r.json();
  return { url, data };
}

// Extrae el objeto JSON del protocolo. Recorre TODOS los objetos balanceados de
// nivel superior (ignora los que están dentro de <think>…</think> o de razonamiento)
// y prefiere el último que contenga "accion"; si no, el último que parsee.
function extractJSON(text) {
  if (!text) return null;
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const candidates = [];
  let depth = 0, inStr = false, esc = false, startIdx = -1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) startIdx = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && startIdx >= 0) { candidates.push(clean.slice(startIdx, i + 1)); startIdx = -1; } }
  }
  let fallback = null;
  for (const cand of candidates) {
    let obj; try { obj = JSON.parse(cand); } catch { continue; }
    fallback = obj;
    if (obj && obj.accion) return obj; // prioriza el objeto del protocolo
  }
  return fallback;
}

async function callLLM(messages, apiKey) {
  const r = await fetch(OPENROUTER, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://unimauro.github.io/pulso-ventas-andina/",
      "X-Title": "Analista Andina",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 900,
      messages,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("OpenRouter " + r.status + ": " + (j.error?.message || JSON.stringify(j)).slice(0, 300));
  return j.choices?.[0]?.message?.content || "";
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Falta configurar LLM_API_KEY en el servidor." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const history = Array.isArray(body?.messages) ? body.messages.slice(-12) : [];
  if (!history.length) return res.status(400).json({ error: "Envía { messages: [...] }" });

  // construye el contexto para el LLM
  const convo = [
    { role: "system", content: SYSTEM },
    ...history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
  ];

  const queries = []; // qué consultó (se devuelve al cliente)
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const raw = await callLLM(convo, apiKey);
      const parsed = extractJSON(raw);

      if (!parsed || !parsed.accion) {
        // el modelo no siguió el protocolo: devolvemos su texto tal cual (sin cifras nuevas)
        return res.status(200).json({ reply: raw.trim() || "No pude generar una respuesta.", queries });
      }

      if (parsed.accion === "final") {
        return res.status(200).json({ reply: String(parsed.respuesta || "").trim(), queries });
      }

      if (parsed.accion === "resumen_ventas") {
        const filtros = parsed.filtros || {};
        let obs;
        try {
          const { url, data } = await resumenVentas(filtros);
          queries.push({ filtros, url, resultado: data });
          obs = JSON.stringify(data);
        } catch (e) {
          obs = JSON.stringify({ error: "No se pudo consultar: " + e.message });
          queries.push({ filtros, error: e.message });
        }
        // registramos la decisión del modelo y la observación de la herramienta
        convo.push({ role: "assistant", content: raw });
        convo.push({ role: "user", content: `[Resultado de resumen_ventas con filtros ${JSON.stringify(filtros)}]:\n${obs}\n\nResponde ahora con el siguiente JSON del protocolo.` });
        continue;
      }

      // acción desconocida
      return res.status(200).json({ reply: raw.trim(), queries });
    }
    // se agotaron los pasos: forzamos un cierre
    convo.push({ role: "user", content: 'Devuelve ya la respuesta final con {"accion":"final","respuesta":"..."} usando sólo las cifras ya obtenidas.' });
    const last = await callLLM(convo, apiKey);
    const p = extractJSON(last);
    return res.status(200).json({ reply: (p?.respuesta || last).trim(), queries });
  } catch (e) {
    return res.status(500).json({ error: e.message, queries });
  }
}
