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

const SYSTEM_PROMPT = `MONITOREO DE PRENSA PEMEX

Analiza la nota proporcionada y entrega el resultado ÚNICAMENTE en este formato exacto, sin ningún texto adicional antes ni después:

🟢/🟡/🔴 Título textual de la nota | Nombre del medio | Digital
- Fragmento textual 1 de la nota.
- Fragmento textual 2 de la nota.
- Fragmento textual 3 de la nota.
URL

SEMÁFORO - Clasifica con UN SOLO emoji al inicio:
🟢 Positiva: nota favorable para Pemex (avances, inversiones, logros, beneficios).
🟡 Neutral: nota informativa sin valoración clara de Pemex.
🔴 Negativa: nota desfavorable (accidentes, fugas, derrames, fallas, deudas, sanciones, denuncias, irregularidades).

TÍTULO: Copia el título exactamente como aparece. No lo modifiques.

BULLETS: Exactamente 3 bullets. Deben ser fragmentos textuales copiados literalmente de la nota, sin resumir ni parafrasear. Si el contenido disponible es limitado, usa lo que haya sin inventar.

RESTRICCIONES ABSOLUTAS:
- No agregues texto antes del emoji semáforo.
- No agregues texto después de la URL.
- No parafrasees ni resumas.
- No inventes información.
- No agregues análisis ni conclusiones.
- Exactamente 3 bullets con •`;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

  async generarMensaje(titulo: string, fuente: string, urlReal: string, contenido: string): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        systemInstruction: SYSTEM_PROMPT,
      });

      const userPrompt = `Título: ${titulo}
Medio: ${fuente}
URL: ${urlReal}
Contenido de la nota:
${contenido || 'Sin contenido disponible - usa solo el título.'}`;

      const result = await model.generateContent(userPrompt);
      return result.response.text().trim();
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

    const mensajeIA = await this.generarMensaje(titulo, fuente, urlReal, contenido);
    const mensaje = mensajeIA || `🟡 ${titulo} | ${fuente} | Digital\n• ${limpiar(noticia.resumen || 'Sin descripción')}\n${urlReal}`;

    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: mensaje,
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
