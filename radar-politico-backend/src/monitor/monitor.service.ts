import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';
import { AlertsService } from '../alerts/alerts.service';

const KEYWORDS = ['Pemex'];

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
      for (const noticia of noticias) {
        if (this.enviadas.has(noticia.url)) continue;
        this.enviadas.add(noticia.url);
        await this.alertsService.enviarAlerta(noticia);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    this.logger.log('Cache: ' + this.enviadas.size + ' URLs');
  }
}
