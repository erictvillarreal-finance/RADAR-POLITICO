import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
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

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  async generarBullets(noticia: Noticia): Promise<string> {
    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Resume esta noticia en 2 bullets concisos en español. Solo los bullets, cada uno empieza con •\n\nTítulo: ${limpiar(noticia.titulo)}\nDescripción: ${limpiar(noticia.resumen)}`,
        }],
        max_tokens: 150,
        temperature: 0.3,
      });
      return escaparHTML(completion.choices[0]?.message?.content?.trim() || '');
    } catch (error) {
      this.logger.error('Error Groq: ' + error.message);
      return '• ' + escaparHTML(limpiar(noticia.resumen || 'Sin descripción'));
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const icono = semaforo(noticia.titulo + ' ' + noticia.resumen);
    const titulo = escaparHTML(limpiar(noticia.titulo));
    const fuente = escaparHTML(limpiar(noticia.fuente));
    const bullets = await this.generarBullets(noticia);
    const mensaje = `${icono} <b>${titulo}</b>\n<b>Fuente: ${fuente}</b>\n\n${bullets}\n\n🔗 <a href="${noticia.url}">Ver nota</a>`;

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
