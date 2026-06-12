import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as xml2js from 'xml2js';

export interface Noticia {
  titulo: string;
  url: string;
  fuente: string;
  fecha: string;
  resumen: string;
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  async scrapearGoogleNews(query: string): Promise<Noticia[]> {
    this.logger.log(`Buscando en Google News: "${query}"`);

    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=MX&ceid=MX:es-419`;

    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      const parsed = await xml2js.parseStringPromise(data);
      const items = parsed?.rss?.channel?.[0]?.item || [];

      const noticias: Noticia[] = items.slice(0, 20).map((item: any) => {
        const titulo = item.title?.[0] || '';
        const link = item.link?.[0] || '';
        const fuente = item.source?.[0]?._ || item.source?.[0] || 'Desconocida';
        const fecha = item.pubDate?.[0] || new Date().toISOString();
        const resumen = item.description?.[0]?.replace(/<[^>]*>/g, '') || '';
        return { titulo, url: link, fuente, fecha, resumen };
      });

      this.logger.log(`Encontradas ${noticias.length} noticias para "${query}"`);
      return noticias;

    } catch (error) {
      this.logger.error(`Error scrapeando Google News`, error.message);
      return [];
    }
  }
}
