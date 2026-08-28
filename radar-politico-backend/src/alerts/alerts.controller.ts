import { Controller, Post, Query } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { ScraperService } from '../scraper/scraper.service';
import { PEMEX_KEYWORDS } from '../keywords';

@Controller('alertas')
export class AlertsController {
  constructor(
    private readonly alertsService: AlertsService,
    private readonly scraperService: ScraperService,
  ) {}

  @Post('monitorear')
  async monitorear(@Query('q') query: string = 'politica mexico') {
    const noticias = await this.scraperService.scrapearGoogleNews(query);
    await this.alertsService.enviarResumen(noticias, query);

    return {
      ok: true,
      enviadas: noticias.length,
      query,
    };
  }

  @Post('disparar')
  async disparar() {
    /*
     * IMPORTANTE:
     * No esperamos a que termine todo el monitoreo.
     *
     * Railway puede devolver 502 si el request permanece abierto
     * mientras procesamos decenas de keywords/noticias.
     *
     * El trabajo continúa en background y el endpoint responde
     * inmediatamente con 202.
     */
    void this.ejecutarMonitoreo();

    return {
      ok: true,
      status: 'started',
      message: 'Monitoreo iniciado en background',
    };
  }

  private async ejecutarMonitoreo(): Promise<void> {
    const keywords = PEMEX_KEYWORDS;

    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const noticiasMap = new Map<string, any>();

    console.log(
      `===== MONITOREO PEMEX INICIADO | ${keywords.length} keywords =====`,
    );

    for (const keyword of keywords) {
      try {
        console.log(`SCRAPER: ${keyword}`);

        const noticias =
          await this.scraperService.scrapearGoogleNews(keyword);

        for (const noticia of noticias) {
          if (!noticia?.url) continue;

          const fecha = new Date(noticia.fecha);

          if (!Number.isNaN(fecha.getTime()) && fecha < hace24h) {
            continue;
          }

          /*
           * Usamos la URL de Google News como deduplicador inicial.
           * Posteriormente el servicio resuelve la URL real.
           */
          const key =
            noticia.url ||
            `${noticia.titulo}|${noticia.fuente}`;

          if (!noticiasMap.has(key)) {
            noticiasMap.set(key, noticia);
          }
        }

        /*
         * Pequeño descanso entre keywords.
         * No son 15 segundos: sólo evitamos disparar requests
         * consecutivos demasiado rápido.
         */
        await new Promise(resolve => setTimeout(resolve, 750));
      } catch (error) {
        console.log(
          `ERROR SCRAPER [${keyword}]: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const noticias = Array.from(noticiasMap.values());

    console.log(
      `===== NOTICIAS ÚNICAS ENCONTRADAS: ${noticias.length} =====`,
    );

    let enviadas = 0;

    for (const noticia of noticias) {
      try {
        await this.alertsService.enviarAlerta(noticia);
        enviadas++;

        /*
         * Delay pequeño entre alertas para evitar ráfagas.
         */
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        console.log(
          `ERROR ALERTA [${noticia.titulo}]: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(
      `===== MONITOREO PEMEX TERMINADO | ENVIADAS: ${enviadas}/${noticias.length} =====`,
    );
  }
}