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

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;
  private readonly genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

  async generarBullets(noticia: Noticia): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const prompt = 'Resume esta noticia en 2 bullets concisos en español. Solo los bullets sin introducción, cada uno empieza con •

Título: ' + noticia.titulo + '
Descripción: ' + noticia.resumen;
      const result = await model.generateContent(prompt);
      return escapar(result.response.text().trim());
    } catch (error) {
      this.logger.error('Error Gemini: ' + error.message);
      return '• ' + escapar(noticia.resumen || 'Sin descripción');
    }
  }

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const icono = semaforo(noticia.titulo + ' ' + noticia.resumen);
    const bullets = await this.generarBullets(noticia);
    const mensaje = icono + ' <b>' + escapar(noticia.titulo) + '</b> | ' + escapar(noticia.fuente) + '
' + bullets + '
🔗 ' + noticia.url;

    try {
      await axios.post('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
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
    const header = '🔍 <b>MONITOREO: "' + query + '"</b>
📊 ' + noticias.length + ' noticias encontradas
' + '─'.repeat(30) + '

';
    const lista = noticias.slice(0, 5).map((n, i) =>
      (i + 1) + '. <a href="' + n.url + '">' + escapar(n.titulo.substring(0, 80)) + '</a>
   📡 ' + escapar(n.fuente)
    ).join('

');
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
