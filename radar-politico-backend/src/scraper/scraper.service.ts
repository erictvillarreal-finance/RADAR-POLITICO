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
    this.logger.log('Buscando en Google News: "' + query + '"');

    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=es-419&gl=MX&ceid=MX:es-419';

    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      const parsed = await xml2js.parseStringPromise(data);
      const items = parsed?.rss?.channel?.[0]?.item || [];

      const noticias: Noticia[] = items.slice(0, 10).map((item: any) => {
        const titulo = item.title?.[0] || '';
        const link = item.link?.[0] || '';
        const fuente = item.source?.[0]?._ || item.source?.[0] || 'Desconocida';
        const fecha = item.pubDate?.[0] || new Date().toISOString();
        const resumen = item.description?.[0]?.replace(/<[^>]*>/g, '') || '';
        return { titulo, url: link, fuente, fecha, resumen };
      });

      this.logger.log('Encontradas ' + noticias.length + ' noticias para "' + query + '"');
      return noticias;

    } catch (error) {
      this.logger.error('Error scrapeando Google News: ' + error.message);
      return [];
    }
  }
}
