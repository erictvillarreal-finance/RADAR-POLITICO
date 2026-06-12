import { Controller, Post, Query } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { ScraperService } from '../scraper/scraper.service';

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
    return { enviadas: noticias.length, query };
  }

  @Post('disparar')
  async disparar() {
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const keywords = ['Pemex','Sener Mexico','Juan Carlos Carpio Fragoso','Director General Pemex','Hidrocarburos Mexico','Huachicol','Toma Clandestina combustible','Pemex Gas','Pemex Diesel','Pemex Gasolina','Pemex Petroleo','Refineria Cadereyta','Pemex Contaminacion','Pemex Desabasto','Robo combustible Mexico','Pemex Ducto','Pemex Poliducto','Pemex Gasoducto','Pemex Pipa','Pemex Autotanque','Pemex Terminal almacenamiento','Pemex TAD','Pemex Gas LP','Pemex Incendio','Pemex Explosion','Pemex Derrame','Pemex Fuga'];
    let total = 0;
    for (const keyword of keywords) {
      await new Promise(r => setTimeout(r, 15000));
      const noticias = await this.scraperService.scrapearGoogleNews(keyword);
      for (const noticia of noticias) {
        if (new Date(noticia.fecha) < hace24h) continue;
        await this.alertsService.enviarAlerta(noticia);
        await new Promise(r => setTimeout(r, 2000));
        total++;
      }
    }
    return { ok: true, enviadas: total };
  }
}
