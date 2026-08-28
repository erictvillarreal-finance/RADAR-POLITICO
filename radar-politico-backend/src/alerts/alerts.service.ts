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

async function leerArticulo(
  url: string,
  logger?: Logger,
): Promise<string> {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      },
      validateStatus: status => status >= 200 && status < 400,
    });

    const $ = cheerio.load(data);

    const limpiarTexto = (texto: string): string => {
      return texto
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const limpiarFragmentos = (fragmentos: string[]): string => {
      const vistos = new Set<string>();

      return fragmentos
        .map(limpiarTexto)
        .filter(texto => texto.length >= 40)
        .filter(texto => {
          const key = texto.toLowerCase();

          if (vistos.has(key)) return false;

          vistos.add(key);
          return true;
        })
        .join(' ')
        .trim();
    };

    // --------------------------------------------------------
    // MÉTODO 1 — JSON-LD articleBody
    // Muy importante para Excélsior y otros publishers.
    // --------------------------------------------------------

    const jsonLdBodies: string[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text().trim();

      if (!raw) return;

      try {
        const parsed = JSON.parse(raw);

        const items = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.['@graph'])
            ? parsed['@graph']
            : [parsed];

        for (const item of items) {
          if (
            item &&
            typeof item === 'object' &&
            typeof item.articleBody === 'string' &&
            item.articleBody.length >= 300
          ) {
            jsonLdBodies.push(item.articleBody);
          }
        }
      } catch {
        // Algunos publishers tienen JSON-LD inválido.
        // Continuamos con los demás métodos.
      }
    });

    if (jsonLdBodies.length > 0) {
      const body = limpiarFragmentos(jsonLdBodies);

      if (body.length >= 300) {
        const resultado = body.substring(0, 8000);

        logger?.log(
          `EXTRACTOR: JSON-LD articleBody | ${resultado.length} chars`,
        );

        return resultado;
      }
    }

    // --------------------------------------------------------
    // Remover elementos que NO forman parte del artículo.
    // --------------------------------------------------------

    $(
      'script, style, noscript, nav, header, footer, aside, ' +
      'form, iframe, svg, canvas, video, audio, ' +
      '[aria-label*="share" i], ' +
      '[class*="share" i], ' +
      '[class*="social" i], ' +
      '[class*="advert" i], ' +
      '[class*="banner" i], ' +
      '[class*="newsletter" i], ' +
      '[class*="related" i], ' +
      '[class*="recommended" i], ' +
      '[class*="comment" i]'
    ).remove();

    // --------------------------------------------------------
    // MÉTODO 2 — article p
    // --------------------------------------------------------

    const articleParagraphs = $('article p')
      .map((_, el) => $(el).text())
      .get();

    const articleText = limpiarFragmentos(articleParagraphs);

    if (articleText.length >= 300) {
      const resultado = articleText.substring(0, 8000);

      logger?.log(
        `EXTRACTOR: article p | ${resultado.length} chars`,
      );

      return resultado;
    }

    // --------------------------------------------------------
    // MÉTODO 3 — itemprop articleBody
    // --------------------------------------------------------

    const itemPropParagraphs = $(
      '[itemprop="articleBody"] p, [itemprop="articleBody"]',
    )
      .map((_, el) => $(el).text())
      .get();

    const itemPropText = limpiarFragmentos(itemPropParagraphs);

    if (itemPropText.length >= 300) {
      const resultado = itemPropText.substring(0, 8000);

      logger?.log(
        `EXTRACTOR: itemprop articleBody | ${resultado.length} chars`,
      );

      return resultado;
    }

    // --------------------------------------------------------
    // MÉTODO 4 — Selectores editoriales conocidos
    // --------------------------------------------------------

    const selectors = [
      '.article-body p',
      '.article-content p',
      '.post-content p',
      '.entry-content p',
      '.story-body p',
      '.story-content p',
      '.nota p',
      '.contenido-nota p',
      '.content p',
      'main p',
    ];

    for (const selector of selectors) {
      const paragraphs = $(selector)
        .map((_, el) => $(el).text())
        .get();

      const text = limpiarFragmentos(paragraphs);

      if (text.length >= 300) {
        const resultado = text.substring(0, 8000);

        logger?.log(
          `EXTRACTOR: ${selector} | ${resultado.length} chars`,
        );

        return resultado;
      }
    }

    logger?.warn(`EXTRACTOR: no se encontró contenido suficiente para ${url}`);

    return '';
  } catch (error) {
    logger?.warn(
      `EXTRACTOR ERROR: ${url} | ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

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

Tu respuesta DEBE ser exclusivamente un objeto JSON válido con esta estructura exacta:

{
  "semaforo": "🟢",
  "fragmentos": [
    "Fragmento textual 1",
    "Fragmento textual 2",
    "Fragmento textual 3"
  ]
}

REGLAS DEL SEMÁFORO:

🟢 POSITIVA
La nota es favorable para Pemex.
Ejemplos:
- avances;
- inversiones;
- mejoras;
- nuevos proyectos;
- beneficios;
- resultados positivos;
- fortalecimiento de Pemex.

🟡 NEUTRAL
La nota es principalmente informativa y no presenta una valoración claramente favorable o desfavorable para Pemex.

🔴 NEGATIVA
La nota presenta información desfavorable para Pemex.
Ejemplos:
- accidentes;
- fugas;
- derrames;
- fallas;
- pérdidas;
- deudas;
- problemas financieros;
- sanciones;
- denuncias;
- investigaciones;
- irregularidades;
- deterioro operativo;
- deterioro financiero;
- dependencia de recursos públicos;
- riesgos para Pemex.

Si existen elementos negativos materiales, NO clasifiques como neutral simplemente porque la nota también contiene información positiva.

REGLAS DE LOS FRAGMENTOS:

1. Debes devolver EXACTAMENTE 3 fragmentos.

2. Cada fragmento debe ser COPIADO LITERALMENTE del CONTENIDO DE LA NOTA proporcionado.

3. NO resumas.

4. NO parafrasees.

5. NO cambies palabras.

6. NO corrijas gramática.

7. NO combines frases de diferentes partes de la nota.

8. NO inventes información.

9. No agregues comillas.

10. No agregues bullets.

11. No agregues emojis.

12. Cada fragmento debe poder encontrarse literalmente dentro del contenido proporcionado.

13. Los fragmentos deben ser sustanciales y representar los puntos más importantes de la nota.

14. Prioriza fragmentos que contengan:
   - hechos;
   - cifras;
   - declaraciones;
   - consecuencias;
   - información financiera u operativa relevante;
   - información directamente relacionada con Pemex.

15. Evita fragmentos que sean únicamente:
   - títulos;
   - nombres de autores;
   - fechas;
   - menús;
   - navegación;
   - publicidad;
   - botones;
   - textos de suscripción.

IMPORTANTE SOBRE EL CONTENIDO:

El contenido proporcionado por el backend proviene de la página original de la noticia.

NO uses el título, URL o nombre del medio para inventar fragmentos.

Los fragmentos deben salir EXCLUSIVAMENTE del campo "CONTENIDO DE LA NOTA".

VALIDACIÓN:

El backend comprobará que cada fragmento exista literalmente dentro del contenido.

Si una frase parece correcta pero no aparece literalmente en el contenido, NO la utilices.

FORMATO DE RESPUESTA:

Devuelve SOLO JSON válido.

No uses Markdown.

No uses bloques de código.

No agregues explicaciones.

No agregues título.

No agregues medio.

No agregues URL.

No agregues campos adicionales.

"semaforo" debe ser exactamente uno de:
🟢
🟡
🔴

"fragmentos" debe contener exactamente 3 strings.

FIN DE INSTRUCCIONES.`;


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

      const userPrompt = `Título de la nota:
${titulo}

Medio:
${fuente}

URL:
${urlReal}

CONTENIDO DE LA NOTA:
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

      const fragmentos = parsed.fragmentos.map((fragmento: unknown) =>
        typeof fragmento === 'string' ? fragmento.trim() : '',
      );

      if (
        fragmentos.length !== 3 ||
        fragmentos.some(fragmento => !fragmento)
      ) {
        this.logger.error('Gemini no devolvió exactamente 3 fragmentos válidos');
        return '';
      }

      // ------------------------------------------------------
      // VALIDACIÓN CRÍTICA:
      // Cada fragmento debe existir literalmente en el artículo.
      // ------------------------------------------------------

      const contenidoNormalizado = contenido
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const fragmentosValidos = fragmentos.map(fragmento =>
        fragmento
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );

      const todosLiterales = fragmentosValidos.every(fragmento =>
        contenidoNormalizado.includes(fragmento),
      );

      if (!todosLiterales) {
        this.logger.error(
          'Gemini devolvió fragmentos que NO existen literalmente en el artículo',
        );

        fragmentosValidos.forEach((fragmento, index) => {
          this.logger.error(
            `FRAGMENTO ${index + 1}: ${fragmento.substring(0, 500)}`,
          );
        });

        return '';
      }

      // ------------------------------------------------------
      // Construimos Telegram NOSOTROS.
      // Gemini no controla el formato final.
      // ------------------------------------------------------

      const fragmentosTelegram = fragmentosValidos
        .map(fragmento => `• ${resaltarPemex(fragmento)}`)
        .join('\n');

      return `${parsed.semaforo} ${titulo} | ${fuente} | Digital

${fragmentosTelegram}

${urlReal}`;
    } catch (error) {
      this.logger.error(
        'Error Gemini: ' +
          (error instanceof Error ? error.message : String(error)),
      );

      return '';
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    const urlReal = await resolverURL(noticia.url, this.logger);
    const articulo = await leerArticulo(urlReal, this.logger);
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
