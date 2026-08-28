import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleDecoder } from 'google-news-url-decoder';
import { Noticia } from '../scraper/scraper.service';

const decoder = new GoogleDecoder();

function limpiar(texto: string): string {
  return texto
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]*>/g, '')
    .trim();
}

async function resolverURL(googleUrl: string, logger: Logger): Promise<string> {
  try {
    const result = await decoder.decode(googleUrl);
    if (result.status && result.decoded_url) return result.decoded_url;
  } catch (e) {
    logger.warn('Decoder fallo: ' + e.message);
  }
  return googleUrl;
}

async function leerArticulo(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    const $ = cheerio.load(data);
    $('script, style, nav, header, footer, aside').remove();
    const texto = $('article p, .content p, .nota p, .entry-content p, main p')
      .map((_, el) => $(el).text())
      .get()
      .join(' ')
      .trim();
    return texto.length > 200 ? texto.substring(0, 4000) : '';
  } catch {
    return '';
  }
}


function escaparTelegramHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resaltarPemex(texto: string): string {
  const escapado = escaparTelegramHtml(texto);
  return escapado.replace(/\bPemex\b/gi, match => `<b>${match}</b>`);
}

const SYSTEM_PROMPT = `MONITOREO DE PRENSA PEMEX

Analiza ÚNICAMENTE el contenido de la nota proporcionada.

Tu tarea es devolver exclusivamente un objeto JSON válido con esta estructura:

{
  "semaforo": "🟢",
  "fragmentos": [
    "Fragmento textual 1",
    "Fragmento textual 2",
    "Fragmento textual 3"
  ]
}

REGLAS DEL SEMÁFORO:
- 🟢 = Positiva: nota favorable para Pemex, incluyendo avances, inversiones, logros o beneficios.
- 🟡 = Neutral: nota informativa sin valoración claramente favorable o desfavorable para Pemex.
- 🔴 = Negativa: nota desfavorable para Pemex, incluyendo accidentes, fugas, derrames, fallas, deudas, sanciones, denuncias o irregularidades.

REGLAS DE LOS FRAGMENTOS:
- Debes devolver EXACTAMENTE 3 fragmentos.
- Cada fragmento debe ser COPIADO LITERALMENTE del contenido proporcionado.
- NO resumas.
- NO parafrasees.
- NO cambies palabras.
- NO combines partes de diferentes frases.
- NO inventes texto.
- Selecciona fragmentos que representen claramente la información principal de la nota.
- Cada fragmento debe poder encontrarse literalmente dentro del contenido proporcionado.
- No incluyas comillas alrededor de los fragmentos.
- No incluyas bullets, guiones ni emojis dentro de los fragmentos.

RESTRICCIONES ABSOLUTAS:
- Devuelve SOLO JSON válido.
- No uses markdown.
- No uses bloques de código.
- No agregues explicaciones.
- No agregues título.
- No agregues medio.
- No agregues URL.
- No agregues ningún campo adicional.
- "semaforo" debe ser exactamente uno de: 🟢, 🟡, 🔴.
- "fragmentos" debe contener exactamente 3 elementos.

IMPORTANTE:
El backend verificará que los 3 fragmentos existan literalmente dentro del contenido de la nota.`;


@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

  async generarMensaje(
    titulo: string,
    fuente: string,
    urlReal: string,
    contenido: string,
  ): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-3.6-flash',
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      const userPrompt = `Título de la nota: ${titulo}
Medio: ${fuente}
URL: ${urlReal}

CONTENIDO COMPLETO DE LA NOTA:
${contenido || 'Sin contenido disponible.'}`;

      const result = await model.generateContent(userPrompt);
      const raw = result.response.text().trim();

      this.logger.log('===== GEMINI RAW JSON =====');
      this.logger.log(raw);
      this.logger.log('===== FIN GEMINI RAW JSON =====');

      let parsed: any;

      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.error('Gemini devolvió JSON inválido');
        return '';
      }

      if (
        !parsed ||
        !['🟢', '🟡', '🔴'].includes(parsed.semaforo) ||
        !Array.isArray(parsed.fragmentos) ||
        parsed.fragmentos.length !== 3
      ) {
        this.logger.error('Gemini devolvió una estructura inválida');
        return '';
      }

      const fragmentos = parsed.fragmentos
        .map((fragmento: unknown) =>
          typeof fragmento === 'string' ? fragmento.trim() : '',
        )
        .filter(Boolean);

      if (fragmentos.length !== 3) {
        this.logger.error('No hay exactamente 3 fragmentos válidos');
        return '';
      }

      // Validación crítica:
      // cada fragmento DEBE existir literalmente en el artículo.
      for (const fragmento of fragmentos) {
        if (!contenido.includes(fragmento)) {
          this.logger.error(
            'Gemini intentó parafrasear o inventar un fragmento: ' +
              fragmento.substring(0, 200),
          );
          return '';
        }
      }

      const tituloTelegram = resaltarPemex(titulo);
      const fragmentosTelegram = fragmentos
        .map(fragmento => `• ${resaltarPemex(fragmento)}`)
        .join('\n');

      return `${parsed.semaforo} ${tituloTelegram} | ${escaparTelegramHtml(fuente)} | Digital\n\n${fragmentosTelegram}\n\n${urlReal}`;
    } catch (error) {
      this.logger.error('Error Gemini: ' + error.message);
      return '';
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    await new Promise(r => setTimeout(r, 8000));
    const urlReal = await resolverURL(noticia.url, this.logger);
    const articulo = await leerArticulo(urlReal);
    const contenido = articulo || limpiar(noticia.resumen || '');

    this.logger.log('===== DEBUG ALERTA =====');
    this.logger.log('TITULO: ' + titulo);
    this.logger.log('FUENTE: ' + fuente);
    this.logger.log('URL GOOGLE: ' + noticia.url);
    this.logger.log('URL REAL: ' + urlReal);
    this.logger.log('ARTICULO LENGTH: ' + articulo.length);
    this.logger.log('CONTENIDO LENGTH: ' + contenido.length);
    this.logger.log('CONTENIDO INICIO: ' + contenido.substring(0, 1500));
    this.logger.log('===== FIN DEBUG =====');

    const mensajeIA = await this.generarMensaje(titulo, fuente, urlReal, contenido);
    this.logger.log('===== GEMINI OUTPUT =====');
    this.logger.log(mensajeIA);
    this.logger.log('===== FIN GEMINI OUTPUT =====');

    const mensaje = mensajeIA || `🟡 ${titulo} | ${fuente} | Digital\n• ${limpiar(noticia.resumen || 'Sin descripción')}\n${urlReal}`;

    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: mensaje,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      this.logger.log('Alerta enviada: ' + titulo.substring(0, 60));
    } catch (error) {
      this.logger.error('Error Telegram: ' + error.message);
    }
  }

  async enviarResumen(noticias: Noticia[], query: string): Promise<void> {
    const texto = `MONITOREO: "${query}"\n${noticias.length} noticias encontradas\n\n` +
      noticias.slice(0, 5).map((n, i) =>
        `${i + 1}. ${limpiar(n.titulo.substring(0, 80))}\n   ${limpiar(n.fuente)}\n   ${n.url}`
      ).join('\n\n');
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: texto,
        disable_web_page_preview: true,
      });
    } catch (error) {
      this.logger.error('Error resumen Telegram: ' + error.message);
    }
  }
}
