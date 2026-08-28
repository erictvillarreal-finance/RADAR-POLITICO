import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GoogleDecoder } from 'google-news-url-decoder';
import { Noticia } from '../scraper/scraper.service';

const ClasificacionSchema = z.object({
  semaforo: z.enum(['🟢', '🟡', '🔴']),
  fragmentos: z.array(z.number().int()).length(3),
});

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
): Promise<string[]> {
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

    /*
     * Eliminamos elementos que no forman parte del cuerpo editorial.
     */
    $(
      'script, style, nav, header, footer, aside, noscript, iframe, form, ' +
      '.advertisement, .ads, .social, .share, .related, .recommended',
    ).remove();

    /*
     * MÉTODO 1 — JSON-LD articleBody
     *
     * Muchos publishers modernos exponen el artículo completo aquí.
     */
    const jsonLdBodies: string[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).contents().text().trim();
        if (!raw) return;

        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of items) {
          if (
            item &&
            typeof item === 'object' &&
            typeof item.articleBody === 'string' &&
            item.articleBody.length > 300
          ) {
            jsonLdBodies.push(item.articleBody);
          }

          if (
            item &&
            typeof item === 'object' &&
            Array.isArray(item['@graph'])
          ) {
            for (const graphItem of item['@graph']) {
              if (
                graphItem &&
                typeof graphItem.articleBody === 'string' &&
                graphItem.articleBody.length > 300
              ) {
                jsonLdBodies.push(graphItem.articleBody);
              }
            }
          }
        }
      } catch {
        // JSON-LD inválido: continuamos con HTML.
      }
    });

    /*
     * MÉTODO 2 — article p
     */
    const articleParagraphs = $('article p')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((text: string) => text.length >= 40);

    /*
     * MÉTODO 3 — main p / selectores editoriales.
     */
    const fallbackParagraphs = $(
      'main p, .content p, .nota p, .entry-content p, ' +
      '[class*="article-body"] p, [class*="article-content"] p, ' +
      '[class*="ArticleBody"] p',
    )
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((text: string) => text.length >= 40);

    let paragraphs: string[] = [];

    if (jsonLdBodies.length > 0) {
      paragraphs = jsonLdBodies
        .flatMap(body =>
          body
            .split(/\n+/)
            .map((text: string) => text.replace(/\s+/g, ' ').trim()),
        )
        .filter((text: string) => text.length >= 40);
    }

    if (paragraphs.length < 3 && articleParagraphs.length >= 3) {
      paragraphs = articleParagraphs;
    }

    if (paragraphs.length < 3 && fallbackParagraphs.length >= 3) {
      paragraphs = fallbackParagraphs;
    }

    /*
     * Eliminamos duplicados preservando el orden.
     */
    paragraphs = [...new Set(paragraphs)];

    /*
     * Convertimos párrafos largos en unidades editoriales más pequeñas.
     *
     * IMPORTANTE:
     * Cada candidato sigue siendo texto REAL extraído del publisher.
     * Claude únicamente elegirá IDs; nunca tendrá que reconstruir el texto.
     */
    const candidatos: string[] = [];

    for (const paragraph of paragraphs) {
      const frases = paragraph
        .match(/[^.!?…]+(?:[.!?…]+|$)/g)
        ?.map((x: string) => x.trim())
        .filter((x: string) => x.length >= 45) || [];

      if (frases.length > 0) {
        candidatos.push(...frases);
      } else if (paragraph.length >= 45) {
        candidatos.push(paragraph);
      }
    }

    const unicos = [...new Set(candidatos)];

    /*
     * Evitamos enviar basura o fragmentos editoriales demasiado cortos.
     */
    const resultado = unicos
      .filter(texto => texto.length >= 45)
      .slice(0, 80);

    logger?.log(
      `EXTRACTOR: ${resultado.length} candidatos editoriales encontrados`,
    );

    if (resultado.length > 0) {
      logger?.log(`EXTRACTOR CANDIDATO 0: ${resultado[0]}`);
    }

    return resultado;
  } catch (error) {
    logger?.warn(
      'Extractor fallo: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return [];
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
  return escapado.replace(
    /Petr[oó]leos Mexicanos \(Pemex\)|Petr[oó]leos Mexicanos|\bPemex\b/gi,
    match => `<b>${match}</b>`,
  );
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly anthropic = new Anthropic();

  async generarMensaje(
    titulo: string,
    fuente: string,
    urlReal: string,
    candidatos: string[],
  ): Promise<string> {
    try {
      if (candidatos.length < 3) {
        this.logger.error(
          `No hay suficientes candidatos editoriales: ${candidatos.length}`,
        );
        return '';
      }

      const candidatosNumerados = candidatos
        .map((texto, index) => `[${index}] ${texto}`)
        .join('\n');

      const systemPrompt = `MONITOREO DE PRENSA PEMEX

Tu tarea es analizar una nota periodística sobre Pemex y clasificarla.

REGLAS DEL SEMÁFORO:

🟢 = Positiva:
La nota presenta información favorable para Pemex, como avances, inversiones, logros, mejoras, beneficios, acuerdos favorables o resultados positivos.

🟡 = Neutral:
La nota es principalmente informativa y no presenta una valoración claramente favorable o desfavorable para Pemex.

🔴 = Negativa:
La nota presenta información desfavorable para Pemex, como accidentes, fugas, derrames, fallas, deudas, pérdidas, sanciones, denuncias, irregularidades, problemas financieros, deterioro operativo, críticas o riesgos.

REGLAS DE LOS FRAGMENTOS:

1. Debes seleccionar EXACTAMENTE 3 IDs.
2. Cada ID debe corresponder a uno de los candidatos proporcionados.
3. Los 3 IDs deben ser diferentes.
4. Selecciona los 3 candidatos que mejor representen la información principal de la nota.
5. Prioriza hechos concretos, cifras, declaraciones o información relevante sobre Pemex.
6. No selecciones frases irrelevantes como fechas, créditos, autores, navegación, publicidad o redes sociales.
7. NO escribas los fragmentos, NO los modifiques, NO inventes texto. Tu única función respecto de los fragmentos es seleccionar sus IDs.

IMPORTANTE:

El backend recuperará directamente el texto original asociado a los IDs seleccionados. No debes reconstruir ni escribir los fragmentos.`;

      const userPrompt = `TÍTULO:
${titulo}

MEDIO:
${fuente}

URL:
${urlReal}

CANDIDATOS TEXTUALES EXTRAÍDOS DIRECTAMENTE DE LA NOTA:

${candidatosNumerados}

Selecciona exactamente 3 IDs que representen mejor la información principal de la nota.`;

      const response = await this.anthropic.messages.parse({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        output_config: {
          format: zodOutputFormat(ClasificacionSchema),
        },
      });

      this.logger.log('===== CLAUDE SELECCION JSON =====');
      this.logger.log(JSON.stringify(response.parsed_output));
      this.logger.log('===== FIN CLAUDE SELECCION JSON =====');

      const parsed = response.parsed_output;

      if (!parsed) {
        this.logger.error('Claude devolvió una estructura inválida');
        return '';
      }

      const indices = parsed.fragmentos;

      if (
        indices.some(index => index < 0 || index >= candidatos.length) ||
        new Set(indices).size !== 3
      ) {
        this.logger.error(
          `Claude devolvió IDs inválidos: ${JSON.stringify(indices)}`,
        );
        return '';
      }

      /*
       * CRÍTICO:
       *
       * Claude solamente seleccionó IDs.
       * El texto que llegará a Telegram viene directamente del extractor.
       */
      const fragmentosSeleccionados = indices.map(
        index => candidatos[index],
      );

      if (fragmentosSeleccionados.length !== 3) {
        this.logger.error('No se pudieron recuperar 3 fragmentos');
        return '';
      }

      const fragmentosTelegram = fragmentosSeleccionados
        .map(fragmento => `• ${resaltarPemex(fragmento)}`)
        .join('\n');

      return `${parsed.semaforo} <b>${resaltarPemex(titulo)} | ${escaparTelegramHtml(fuente)} | Digital</b>

${fragmentosTelegram}

${escaparTelegramHtml(urlReal)}`;
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        this.logger.error('Claude rate limit alcanzado: ' + error.message);
      } else if (error instanceof Anthropic.AuthenticationError) {
        this.logger.error('Claude API key inválida: ' + error.message);
      } else if (error instanceof Anthropic.APIError) {
        this.logger.error(
          `Error Claude (${error.status}): ` + error.message,
        );
      } else {
        this.logger.error(
          'Error Claude: ' +
            (error instanceof Error ? error.message : String(error)),
        );
      }

      return '';
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    const urlReal = await resolverURL(noticia.url, this.logger);
    const candidatos = await leerArticulo(urlReal, this.logger);

    /*
     * Si el publisher no pudo ser extraído, usamos el resumen como
     * último recurso, pero NO fingimos que son tres fragmentos.
     */
    if (candidatos.length < 3) {
      this.logger.warn(
        `No se obtuvieron suficientes candidatos para: ${titulo}`,
      );

      const resumen = limpiar(noticia.resumen || '');

      if (!resumen) {
        this.logger.warn(`Sin contenido disponible: ${titulo}`);
        return;
      }

      /*
       * Intentamos construir candidatos únicamente a partir del resumen
       * real recibido de Google News.
       */
      const fallback = resumen
        .match(/[^.!?…]+(?:[.!?…]+|$)/g)
        ?.map((x: string) => x.trim())
        .filter((x: string) => x.length >= 30) || [];

      if (fallback.length < 3) {
        this.logger.warn(
          `Contenido insuficiente incluso en fallback: ${titulo}`,
        );
        return;
      }

      candidatos.push(...fallback);
    }

    this.logger.log('===== DEBUG ALERTA =====');
    this.logger.log('TITULO: ' + titulo);
    this.logger.log('FUENTE: ' + fuente);
    this.logger.log('URL GOOGLE: ' + noticia.url);
    this.logger.log('URL REAL: ' + urlReal);
    this.logger.log('CANDIDATOS: ' + candidatos.length);
    this.logger.log('===== FIN DEBUG =====');

    const mensajeIA = await this.generarMensaje(
      titulo,
      fuente,
      urlReal,
      candidatos,
    );

    this.logger.log('===== MENSAJE FINAL =====');
    this.logger.log(mensajeIA);
    this.logger.log('===== FIN MENSAJE FINAL =====');

    /*
     * No enviamos fallback de una sola línea.
     *
     * Si Claude no puede producir el contrato completo, preferimos
     * NO mandar una alerta incompleta antes que romper el formato.
     */
    if (!mensajeIA) {
      this.logger.warn(
        `Alerta descartada por no cumplir contrato: ${titulo}`,
      );
      return;
    }

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text: mensajeIA,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        },
      );

      this.logger.log(
        'Alerta enviada: ' + titulo.substring(0, 60),
      );
    } catch (error) {
      this.logger.error(
        'Error Telegram: ' +
          (error instanceof Error ? error.message : String(error)),
      );
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