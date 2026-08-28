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
     * Gemini únicamente elegirá IDs; nunca tendrá que reconstruir el texto.
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
  return escapado.replace(/\bPemex\b/gi, match => `<b>${match}</b>`);
}

const SYSTEM_PROMPT = `MONITOREO DE PRENSA PEMEX

ROL:
Eres un clasificador editorial especializado en monitoreo de prensa sobre Petróleos Mexicanos (Pemex).

Analiza ÚNICAMENTE el contenido de la nota proporcionada.

Tu respuesta será consumida directamente por un backend.
NO redactes, NO resumas y NO reformules ningún texto.

TU ÚNICA FUNCIÓN ES:
1. Clasificar la nota con un semáforo.
2. Seleccionar exactamente 3 fragmentos mediante sus IDs.

==================================================
REGLA PRINCIPAL DEL SEMÁFORO
==================================================

Clasifica según el IMPACTO DE LA INFORMACIÓN SOBRE PEMEX.

🟢 POSITIVA

Usa 🟢 cuando la información represente un efecto favorable, mejora, avance o beneficio para Pemex.

Ejemplos:
- aumento o recuperación de producción;
- nuevas inversiones;
- reducción de deuda o costos;
- nuevos proyectos favorables;
- mejoras operativas;
- incremento de capacidad;
- descubrimientos relevantes;
- acuerdos que beneficien claramente a Pemex;
- resultados positivos;
- fortalecimiento financiero u operativo;
- acciones exitosas contra problemas que afectan a Pemex.

🟡 NEUTRAL

Usa 🟡 ÚNICAMENTE cuando la nota sea genuinamente informativa y NO exista un impacto material claramente positivo o negativo para Pemex.

Ejemplos:
- anuncio administrativo sin impacto claro;
- descripción de una reunión;
- declaración meramente descriptiva;
- información factual sin consecuencias favorables o desfavorables identificables;
- cobertura de un evento donde Pemex aparece como actor pero la información no implica mejora ni deterioro.

IMPORTANTE:
El hecho de que una nota tenga un tono periodístico neutral NO significa que sea 🟡.

🔴 NEGATIVA

Usa 🔴 cuando la nota contenga información que represente deterioro, riesgo, problema, pérdida, debilidad, costo, incumplimiento o afectación para Pemex.

Incluye, entre otros:

- deuda;
- pérdidas;
- déficit;
- falta de liquidez;
- necesidad de rescates o apoyos financieros;
- dependencia de recursos públicos;
- caída de producción;
- menor capacidad operativa;
- aumento de costos;
- problemas financieros;
- problemas de infraestructura;
- accidentes;
- incendios;
- explosiones;
- fugas;
- derrames;
- contaminación;
- fallas;
- desabasto;
- robo de combustible;
- huachicol;
- tomas clandestinas;
- sanciones;
- investigaciones;
- denuncias;
- corrupción;
- irregularidades;
- conflictos legales;
- incumplimientos;
- riesgos regulatorios;
- problemas laborales;
- afectaciones reputacionales;
- declaraciones o datos que evidencien deterioro de Pemex.

==================================================
REGLA DE PRIORIDAD
==================================================

Si una nota contiene información tanto positiva como negativa, clasifica según el IMPACTO MATERIAL DOMINANTE sobre Pemex.

Si existen hechos negativos materiales, NO clasifiques automáticamente como 🟡 por el simple hecho de que la nota sea informativa.

Una nota puede estar escrita de manera neutral y aun así ser 🔴.

El semáforo depende del CONTENIDO Y SUS CONSECUENCIAS PARA PEMEX, no del tono del periodista.

==================================================
REGLA ESPECIAL PARA DATOS FINANCIEROS Y OPERATIVOS
==================================================

Los siguientes elementos deben considerarse señales NEGATIVAS cuando impliquen deterioro o presión sobre Pemex:

- deuda elevada;
- necesidad de financiamiento o rescate;
- transferencias extraordinarias del gobierno;
- pérdidas;
- flujo de efectivo insuficiente;
- caída de producción;
- caída de ventas;
- aumento de costos;
- menor rentabilidad;
- deterioro de activos;
- reducción de reservas;
- dependencia creciente del apoyo gubernamental;
- necesidad de recursos para evitar problemas operativos o financieros.

Si varios de estos elementos aparecen juntos, la clasificación debe ser 🔴 salvo que el contenido demuestre claramente que la situación fue revertida o mejorada.

==================================================
EJEMPLO CRÍTICO
==================================================

Si la nota contiene información como:

"Pemex necesita cientos de millones de pesos diarios para mantenerse operando."

"Pemex acumula una deuda muy elevada."

"Pemex requiere apoyo financiero del gobierno."

"Pemex produce significativamente menos petróleo que antes."

"Producir cada barril cuesta más."

La clasificación correcta es:

🔴

Aunque el artículo sea una columna de opinión.

Aunque utilice datos de terceros.

Aunque también mencione acciones positivas del gobierno.

Aunque el tono del artículo sea periodístico o analítico.

==================================================
REGLAS PARA LOS FRAGMENTOS
==================================================

Recibirás una lista de candidatos numerados.

Debes seleccionar EXACTAMENTE 3 candidatos.

Los candidatos ya fueron extraídos literalmente de la nota por el backend.

NO escribas los fragmentos.

NO copies el texto de los candidatos en tu respuesta.

Devuelve únicamente sus IDs.

Selecciona los 3 candidatos que mejor representen la información principal de la nota.

PRIORIDAD:

1. Hechos o datos más relevantes.
2. Información que explique claramente el motivo del semáforo.
3. Información con mayor relevancia para Pemex.
4. Información concreta sobre impacto financiero, operativo, legal, ambiental, reputacional o de seguridad.

Si la nota es negativa, prioriza candidatos que demuestren el deterioro, riesgo, costo o problema.

Si la nota es positiva, prioriza candidatos que demuestren el avance, beneficio o mejora.

Si la nota es neutral, prioriza candidatos que representen los hechos principales.

EVITA:
- fechas;
- nombres de secciones;
- créditos del periodista;
- frases genéricas;
- navegación;
- publicidad;
- texto editorial irrelevante;
- información repetida.

==================================================
REGLAS ABSOLUTAS
==================================================

- Analiza únicamente la información proporcionada.
- No utilices conocimiento externo.
- No inventes información.
- No agregues explicaciones.
- No escribas análisis.
- No escribas resúmenes.
- No escribas los fragmentos.
- No modifiques ningún candidato.
- No devuelvas texto fuera del JSON.
- No uses Markdown.
- No uses bloques de código.
- No agregues campos adicionales.
- "semaforo" debe ser exactamente uno de: 🟢, 🟡, 🔴.
- "ids" debe contener exactamente 3 números enteros.
- Cada ID debe corresponder exactamente a uno de los candidatos proporcionados.
- No repitas IDs.

==================================================
FORMATO DE RESPUESTA OBLIGATORIO
==================================================

{
  "semaforo": "🔴",
  "ids": [12, 18, 21]
}

El ejemplo anterior es únicamente ilustrativo.
Los IDs y el semáforo deben determinarse exclusivamente a partir de la nota recibida.

RESPONDE ÚNICAMENTE CON JSON VÁLIDO.`;



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

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-3.6-flash',
        systemInstruction: `MONITOREO DE PRENSA PEMEX

Tu tarea es analizar una nota periodística sobre Pemex y devolver ÚNICAMENTE JSON válido.

ESTRUCTURA OBLIGATORIA:

{
  "semaforo": "🟢",
  "fragmentos": [0, 1, 2]
}

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
3. Los IDs deben ser números enteros válidos.
4. Los 3 IDs deben ser diferentes.
5. Selecciona los 3 candidatos que mejor representen la información principal de la nota.
6. Prioriza hechos concretos, cifras, declaraciones o información relevante sobre Pemex.
7. No selecciones frases irrelevantes como fechas, créditos, autores, navegación, publicidad o redes sociales.
8. NO escribas los fragmentos.
9. NO modifiques ningún texto.
10. NO inventes texto.
11. Tu única función respecto de los fragmentos es seleccionar sus IDs.

RESTRICCIONES ABSOLUTAS:

- Devuelve SOLO JSON.
- No uses markdown.
- No uses bloques de código.
- No agregues explicaciones.
- No agregues título.
- No agregues medio.
- No agregues URL.
- No agregues campos adicionales.
- "semaforo" debe ser exactamente uno de: 🟢, 🟡, 🔴.
- "fragmentos" debe contener exactamente 3 IDs diferentes.
- Todos los IDs deben existir en la lista proporcionada.

IMPORTANTE:

El backend recuperará directamente el texto original asociado a los IDs seleccionados. Gemini NO debe reconstruir ni escribir los fragmentos.`,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      const userPrompt = `TÍTULO:
${titulo}

MEDIO:
${fuente}

URL:
${urlReal}

CANDIDATOS TEXTUALES EXTRAÍDOS DIRECTAMENTE DE LA NOTA:

${candidatosNumerados}

Selecciona exactamente 3 IDs que representen mejor la información principal de la nota.`;

      const result = await model.generateContent(userPrompt);
      const raw = result.response.text().trim();

      this.logger.log('===== GEMINI SELECCION JSON =====');
      this.logger.log(raw);
      this.logger.log('===== FIN GEMINI SELECCION JSON =====');

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

      const indices = parsed.fragmentos.map((value: unknown) => {
        if (typeof value === 'number' && Number.isInteger(value)) {
          return value;
        }

        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
          return Number(value.trim());
        }

        return -1;
      });

      if (
        indices.some(index => index < 0 || index >= candidatos.length) ||
        new Set(indices).size !== 3
      ) {
        this.logger.error(
          `Gemini devolvió IDs inválidos: ${JSON.stringify(indices)}`,
        );
        return '';
      }

      /*
       * CRÍTICO:
       *
       * Gemini solamente seleccionó IDs.
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

      return `${parsed.semaforo} ${escaparTelegramHtml(titulo)} | ${escaparTelegramHtml(fuente)} | Digital

${fragmentosTelegram}

${escaparTelegramHtml(urlReal)}`;
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
     * Si Gemini no puede producir el contrato completo, preferimos
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
