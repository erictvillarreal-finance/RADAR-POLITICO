import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Noticia } from '../scraper/scraper.service';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;

  async enviarAlerta(noticia: Noticia): Promise<void> {
    const mensaje = `🚨 *RADAR POLÍTICO MX*\n\n📰 *${noticia.titulo}*\n\n📡 Fuente: ${noticia.fuente}\n📅 ${new Date(noticia.fecha).toLocaleString('es-MX')}\n\n🔗 [Ver nota](${noticia.url})`;
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: mensaje,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      this.logger.log(`Alerta enviada: ${noticia.titulo.substring(0, 50)}`);
    } catch (error) {
      this.logger.error('Error enviando alerta Telegram', error.message);
    }
  }

  async enviarResumen(noticias: Noticia[], query: string): Promise<void> {
    const header = `🔍 *MONITOREO: "${query}"*\n📊 ${noticias.length} noticias encontradas\n${'─'.repeat(30)}\n\n`;
    const lista = noticias.slice(0, 5).map((n, i) =>
      `${i + 1}. [${n.titulo.substring(0, 80)}](${n.url})\n   📡 ${n.fuente}`
    ).join('\n\n');
    const mensaje = header + lista;
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: mensaje,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
      this.logger.log(`Resumen enviado para query: ${query}`);
    } catch (error) {
      this.logger.error('Error enviando resumen Telegram', error.message);
    }
  }
}
