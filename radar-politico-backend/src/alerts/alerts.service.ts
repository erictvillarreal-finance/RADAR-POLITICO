import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Groq from 'groq-sdk';
import { Noticia } from '../scraper/scraper.service';

const PALABRAS_NEGATIVAS = ['derrame','explosion','explosión','incendio','fuga','robo','huachicol','toma clandestina','contaminacion','contaminación','desabasto','accidente','muerte','muertos','heridos','sancion','sanción','multa','corrupcion','corrupción','fraude','demanda','denuncia','crisis','falla','fallo','colapso','bloqueo','protesta','manifestacion','manifestación'];
const PALABRAS_POSITIVAS = ['inauguracion','inauguración','inversion','inversión','record','récord','acuerdo','convenio','logro','avance','crecimiento','produccion','producción','mejora','exito','éxito','nuevo contrato','ampliacion','ampliación'];

function semaforo(texto: string): string {
  const t = texto.toLowerCase();
  if (PALABRAS_NEGATIVAS.some(p => t.includes(p))) return '🔴';
  if (PALABRAS_POSITIVAS.some(p => t.includes(p))) return '🟢';
  return '🟡';
}

function limpiar(texto: string): string {
  return texto.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '').trim();
}

function escaparHTML(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function resolverURL(googleUrl: string): Promise<string> {
  try {
    const response = await axios.get(googleUrl, {
      maxRedirects: 5,
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    return response.request.res.responseUrl || googleUrl;
  } catch {
    return googleUrl;
  }
}

async function leerArticulo(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

const SYSTEM_PROMPT = `Actúa como un sistema de inteligencia de medios especializado en extracción y estructuración de información, no en interpretación.
Tu única función es tomar información explícita de la nota periodística y reorganizarla en formato estandarizado.

REGLA FUNDAMENTAL:
NO hagas análisis. NO infieras. NO interpretes. NO agregues contexto externo.
SOLO reescribe información explícita del texto original de la nota, con el máximo detalle posible que el contenido permita.

Genera exactamente 3 bullets. CADA BULLET DEBE TENER ENTRE 2 Y 3 ORACIONES COMPLETAS (no una sola oración corta), desarrollando con detalle el hecho, dato, cifra o declaración que describe. Usa todos los datos concretos disponibles en el contenido: nombres, cargos, cifras, lugares, fechas, declaraciones textuales.
No se permite información que no esté presente en la fuente, pero SI debes aprovechar y desarrollar toda la información disponible, no resumirla en exceso.
Cada bullet debe contener un hecho o ángulo distinto, sin repetición entre ellos.
Mantén estilo de redacción institucional, claro y formal, como un boletín de inteligencia de medios.

EJEMPLO DE NIVEL DE DETALLE ESPERADO:
- Ingenieros petroleros egresados de instituciones en Tabasco han optado por emigrar a otras ciudades del país en busca de mejores oportunidades laborales. El fenómeno es reportado en el sector profesional del estado.
- El secretario del Colegio de Ingenieros Petroleros de México, sección Villahermosa, informó que la organización agrupa a 300 profesionales del ramo en la región. Se mencionan procesos de formación continua entre los agremiados.
- Se señala que Pemex aún ofrece espacios de nuevo ingreso, al igual que empresas privadas, principalmente en proyectos en tierra.

RESPONDE UNICAMENTE CON LOS 3 BULLETS EN ESE NIVEL DE DETALLE, cada uno en su propia línea comenzando con •. Sin introducciones, sin saludos, sin texto adicional antes o después.`;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  async generarBullets(titulo: string, contenido: string): Promise<string> {
    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Título: ${titulo}\nContenido de la nota: ${contenido}` },
        ],
        max_tokens: 500,
        temperature: 0.1,
      });
      return escaparHTML(completion.choices[0]?.message?.content?.trim() || '');
    } catch (error) {
      this.logger.error('Error Groq: ' + error.message);
      return '';
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const icono = semaforo(noticia.titulo + ' ' + noticia.resumen);
    const titulo = limpiar(noticia.titulo);
    const fuente = limpiar(noticia.fuente);

    await new Promise(r => setTimeout(r, 10000));
    const urlReal = await resolverURL(noticia.url);
    const articulo = await leerArticulo(urlReal);

    const contenido = articulo || limpiar(noticia.resumen);
    const bullets = await this.generarBullets(titulo, contenido);
    const bulletsFinal = bullets || '• ' + escaparHTML(limpiar(noticia.resumen || 'Sin descripción'));

    const mensaje = `${icono} <b>${escaparHTML(titulo)}</b> | ${escaparHTML(fuente)} | Digital\n\n${bulletsFinal}\n\nURL: ${urlReal}`;

    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
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

  async enviarResumen(noticias: Noticia[], query: string): Promise<void> {
    const header = `🔍 <b>MONITOREO: "${query}"</b>\n📊 ${noticias.length} noticias encontradas\n${'─'.repeat(30)}\n\n`;
    const lista = noticias.slice(0, 5).map((n, i) =>
      `${i + 1}. <a href="${n.url}">${escaparHTML(limpiar(n.titulo.substring(0, 80)))}</a>\n   📡 ${escaparHTML(limpiar(n.fuente))}`
    ).join('\n\n');
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
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
