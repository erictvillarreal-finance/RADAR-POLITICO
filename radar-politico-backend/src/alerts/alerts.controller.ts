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
}
