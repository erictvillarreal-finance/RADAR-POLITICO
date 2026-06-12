import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

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
  private readonly apiKey = process.env.NEWSAPI_KEY;

  async scrapearGoogleNews(query: string): Promise<Noticia[]> {
    this.logger.log('Buscando en NewsAPI: "' + query + '"');

    try {
      const { data } = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          language: 'es',
          sortBy: 'publishedAt',
          pageSize: 20,
          apiKey: this.apiKey,
        },
        timeout: 10000,
      });

      const noticias: Noticia[] = (data.articles || []).map((a: any) => ({
        titulo: a.title || '',
        url: a.url || '',
        fuente: a.source?.name || 'Desconocida',
        fecha: a.publishedAt || new Date().toISOString(),
        resumen: a.description || '',
      }));

      this.logger.log('Encontradas ' + noticias.length + ' noticias para "' + query + '"');
      return noticias;

    } catch (error) {
      this.logger.error('Error en NewsAPI', error.message);
      return [];
    }
  }
}
