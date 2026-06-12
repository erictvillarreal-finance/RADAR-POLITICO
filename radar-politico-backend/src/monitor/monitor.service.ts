import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';
import { AlertsService } from '../alerts/alerts.service';

const KEYWORDS = [
  'Pemex',
  'Pemex Sener',
  'Pemex Juan Carlos Carpio',
  'Pemex Director General',
  'Pemex Hidrocarburos',
  'Pemex Huachicol',
  'Pemex Toma Clandestina',
  'Pemex Gas',
  'Pemex Diesel',
  'Pemex Gasolina',
  'Pemex Petroleo',
  'Refineria Cadereyta',
  'Pemex Contaminacion',
  'Pemex Desabasto',
  'Pemex Robo combustible',
  'Pemex Ducto',
  'Pemex Poliducto',
  'Pemex Gasoducto',
  'Pemex Pipa',
  'Pemex Autotanque',
  'Pemex Terminal almacenamiento',
  'Pemex TAD',
  'Pemex Gas LP',
  'Pemex Incendio',
  'Pemex Explosion',
  'Pemex Derrame',
  'Pemex Fuga',
];

@Injectable()
export class MonitorService {
  private readonly logger = new Logger(MonitorService.name);
  private readonly enviadas = new Set<string>();

  constructor(
    private readonly scraperService: ScraperService,
    private readonly alertsService: AlertsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitorear() {
    this.logger.log('Iniciando monitoreo ' + new Date().toLocaleString('es-MX'));
    for (const keyword of KEYWORDS) {
      const noticias = await this.scraperService.scrapearGoogleNews(keyword);
      const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for (const noticia of noticias) {
        const fechaNoticia = new Date(noticia.fecha);
        if (fechaNoticia < hace24h) continue;
        if (this.enviadas.has(noticia.url)) continue;
        this.enviadas.add(noticia.url);
        await this.alertsService.enviarAlerta(noticia);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    this.logger.log('Cache: ' + this.enviadas.size + ' URLs');
  }
}
