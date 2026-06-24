import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Groq from 'groq-sdk';
import { GoogleDecoder } from 'google-news-url-decoder';
import { Noticia } from '../scraper/scraper.service';

const PALABRAS_NEGATIVAS = ['derrame','explosion','explosión','incendio','fuga','robo','huachicol','toma clandestina','contaminacion','contaminación','desabasto','accidente','muerte','muertos','heridos','sancion','sanción','multa','corrupcion','corrupción','fraude','demanda','denuncia','crisis','falla','fallo','colapso','bloqueo','protesta','manifestacion','manifestación'];
const PALABRAS_POSITIVAS = ['inauguracion','inauguración','inversion','inversión','record','récord','acuerdo','convenio','logro','avance','crecimiento','produccion','producción','mejora','exito','éxito','nuevo contrato','ampliacion','ampliación'];

const decoder = new GoogleDecoder();

function semaforo(texto) {
  const t = texto.toLowerCase();
  if (PALABRAS_NEGATIVAS.some(p => t.includes(p))) return '🔴';
  if (PALABRAS_POSITIVAS.some(p => t.includes(p))) return '🟢';
  return '🟡';
}

function limpiar(texto) {
  return texto.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '').trim();
}

function escaparHTML(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function espaciarBullets(texto) {
  return texto.split("\n").map(l => l.trim()).filter(l => l.length > 0).join("\n\n");
}

async function resolverURL(googleUrl, logger) {
  try {
    const result = await decoder.decode(googleUrl);
    if (result.status && result.decoded_url) {
      return result.decoded_url;
    }
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    const dollarSign = cheerio.load(data);
    dollarSign('script, style, nav, header, footer, aside, .ad, .publicidad, .related').remove();
    const texto = dollarSign('article p, .content p, .nota p, .entry-content p, main p').map((_, el) => dollarSign(el).text()).get().join(' ').trim();
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

  async generarBullets(titulo, contenido) {
    try {
      const prompt = 'Genera exactamente 3 bullets que resuman esta noticia. Cada bullet debe tener 2-3 lineas: Bullet 1 el hecho principal, Bullet 2 un dato complementario, Bullet 3 un segundo dato o declaracion relevante.\n\nREGLAS CRITICAS:\n- Solo informacion explicita del texto.\n- Prohibido inferir causas, consecuencias o tendencias.\n- Prohibido agregar contexto externo.\n- Prohibido editorializar o interpretar.\n- Mantener estilo de redaccion institucional clara.\n- Cada bullet debe ser independiente y no repetitivo.\n- Maxima fidelidad al contenido original.\n- Si la informacion es limitada, resume solo lo disponible sin inventar contexto.\n\nRESPONDE UNICAMENTE CON LOS 3 BULLETS, cada uno en su propia linea comenzando con el caracter bullet point. Sin introducciones, sin saludos, sin texto antes o despues.\n\nTitulo: ' + titulo + '\nContenido: ' + contenido;

      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.2,
      });
      const texto = completion.choices[0] && completion.choices[0].message ? completion.choices[0].message.content : '';
      return escaparHTML((texto || '').trim());
    } catch (error) {
      this.logger.error('Error Groq: ' + error.message);
      return '';
    }
  }

  async enviarAlerta(noticia) {
    const icono = semaforo(noticia.titulo + ' ' + noticia.resumen);
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    await new Promise(r => setTimeout(r, 10000));
    const urlReal = await resolverURL(noticia.url, this.logger);
    const articulo = await leerArticulo(urlReal);

    const contenido = articulo || limpiar(noticia.resumen);
    const bullets = await this.generarBullets(titulo, contenido);
    const bulletsFinal = bullets || ('punto ' + escaparHTML(limpiar(noticia.resumen || 'Sin descripcion')));
    const bulletsConEspacio = espaciarBullets(bulletsFinal);

    const mensaje = icono + ' <b>' + escaparHTML(titulo) + '</b> ' + escaparHTML(fuente) + ' digital\n\n' + bulletsConEspacio + '\n\nURL: ' + urlReal;

    try {
      await axios.post('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        chat_id: this.chatId,
        text: mensaje,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      this.logger.log('Alerta enviada: ' + titulo.substring(0, 50));
    } catch (error) {
      this.logger.error('Error enviando alerta Telegram: ' + error.message);
    }
  }

  async enviarResumen(noticias, query) {
    const header = '🔍 <b>MONITOREO: "' + query + '"</b>\n📊 ' + noticias.length + ' noticias encontradas\n' + '─'.repeat(30) + '\n\n';
    const lista = noticias.slice(0, 5).map((n, i) =>
      (i + 1) + '. <a href="' + n.url + '">' + escaparHTML(limpiar(n.titulo.substring(0, 80))) + '</a>\n   📡 ' + escaparHTML(limpiar(n.fuente))
    ).join('\n\n');
    try {
      await axios.post('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        chat_id: this.chatId,
        text: header + lista,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      this.logger.error('Error enviando resumen: ' + error.message);
    }
  }
}

@Injectable()
export class AlertsService extends AlertsServiceClass {}
