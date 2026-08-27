import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Groq from 'groq-sdk';
import { GoogleDecoder } from 'google-news-url-decoder';
import { Noticia } from '../scraper/scraper.service';

const decoder = new GoogleDecoder();

function limpiar(texto) {
  return texto.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '').trim();
}

async function resolverURL(googleUrl, logger) {
  try {
    const result = await decoder.decode(googleUrl);
    if (result.status && result.decoded_url) return result.decoded_url;
    logger.warn('Decoder fallo: ' + result.message);
  } catch (error) {
    logger.warn('Error decoder: ' + error.message);
  }
  return googleUrl;
}

async function leerArticulo(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
        'Accept': 'text/html',
      },
    });
    const $ = cheerio.load(data);
    $('script, style, nav, header, footer, aside, .ad, .publicidad, .related').remove();
    const texto = $('article p, .content p, .nota p, .entry-content p, main p').map((_, el) => $(el).text()).get().join(' ').trim();
    return texto.length > 200 ? texto.substring(0, 3000) : '';
  } catch {
    return '';
  }
}

class AlertsServiceClass {
  logger;
  botToken;
  chatId;
  groq;

  constructor() {
    this.logger = new Logger('AlertsService');
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  async generarMensaje(titulo, fuente, urlReal, contenido) {
    try {
      const prompt = 'MONITOREO DE PRENSA PEMEX\n\nAnaliza la nota y entrega UNICAMENTE esto, sin texto adicional:\n\n[SEMAFORO] Titulo textual de la nota | ' + fuente + ' | Digital\n* Fragmento 1\n* Fragmento 2\n* Fragmento 3\n' + urlReal + '\n\nSEMAFORO:\n- Verde: nota favorable para Pemex\n- Amarillo: nota neutral\n- Rojo: nota desfavorable (accidentes, fugas, derrames, fallas, deudas, sanciones)\n\nBULLETS: Si tienes contenido suficiente, copia 3 fragmentos textuales distintos de la nota. Si el contenido es limitado (solo titulo o descripcion corta), genera 1 bullet con lo disponible y deja los otros 2 vacios o con guion. NUNCA repitas el mismo texto en varios bullets. NUNCA inventes informacion.\n\nNOTA:\nTitulo: ' + titulo + '\nContenido: ' + contenido;

      const completion = await this.groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.1,
      });
      const texto = completion.choices[0] && completion.choices[0].message ? completion.choices[0].message.content : '';
      return (texto || '').trim();
    } catch (error) {
      this.logger.error('Error Groq: ' + error.message);
      return '';
    }
  }

  async enviarAlerta(noticia) {
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    await new Promise(r => setTimeout(r, 10000));
    const urlReal = await resolverURL(noticia.url, this.logger);
    const articulo = await leerArticulo(urlReal);
    const contenido = articulo || limpiar(noticia.resumen);

    const mensajeGroq = await this.generarMensaje(titulo, fuente, urlReal, contenido);
    const mensaje = mensajeGroq || ('🟡 ' + titulo + ' | ' + fuente + ' | Digital\n• ' + limpiar(noticia.resumen || 'Sin descripcion') + '\n' + urlReal);

    try {
      await axios.post('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        chat_id: this.chatId,
        text: mensaje,
        disable_web_page_preview: false,
      });
      this.logger.log('Alerta enviada: ' + titulo.substring(0, 50));
    } catch (error) {
      this.logger.error('Error enviando alerta Telegram: ' + error.message);
    }
  }

  async enviarResumen(noticias, query) {
    const header = 'MONITOREO: "' + query + '"\n' + noticias.length + ' noticias encontradas\n\n';
    const lista = noticias.slice(0, 5).map((n, i) =>
      (i + 1) + '. ' + limpiar(n.titulo.substring(0, 80)) + '\n   ' + limpiar(n.fuente) + '\n   ' + n.url
    ).join('\n\n');
    try {
      await axios.post('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        chat_id: this.chatId,
        text: header + lista,
        disable_web_page_preview: true,
      });
    } catch (error) {
      this.logger.error('Error enviando resumen: ' + error.message);
    }
  }
}

@Injectable()
export class AlertsService extends AlertsServiceClass {}
