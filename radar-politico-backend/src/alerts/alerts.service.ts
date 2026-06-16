import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
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
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return response.request.res.responseUrl || googleUrl;
  } catch {
    return googleUrl;
  }
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

  async generarBullets(noticia: Noticia): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const titulo = limpiar(noticia.titulo);
      const descripcion = limpiar(noticia.resumen);
      const prompt = `Resume esta noticia en 2-3 bullets concisos en español. Responde SOLO con los bullets, cada uno en una línea nueva comenzando con •\n\nTítulo: ${titulo}\nDescripción: ${descripcion}`;
      await new Promise(r => setTimeout(r, 5000));
      const result = await model.generateContent(prompt);
      const texto = result.response.text().trim();
      return escaparHTML(texto);
    } catch (error) {
      this.logger.error('Error Gemini: ' + error.message);
      return '• ' + escaparHTML(limpiar(noticia.resumen || 'Sin descripción'));
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const icono = semaforo(noticia.titulo + ' ' + noticia.resumen);
    const titulo = escaparHTML(limpiar(noticia.titulo));
    const fuente = escaparHTML(limpiar(noticia.fuente));
    const bullets = await this.generarBullets(noticia);
    const urlReal = await resolverURL(noticia.url);
    
    const mensaje = `${icono} <b>${titulo}</b>\n<b>Fuente: ${fuente}</b>\n\n${bullets}\n\n🔗 <a href="${urlReal}">Ver nota</a>`;

    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: mensaje,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      this.logger.log('Alerta enviada: ' + noticia.titulo.substring(0, 50));
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
