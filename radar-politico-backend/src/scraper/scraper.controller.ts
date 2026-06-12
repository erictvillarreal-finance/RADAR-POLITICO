import { Controller, Get, Query } from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Get('buscar')
  async buscar(@Query('q') query: string = 'politica mexico') {
    return this.scraperService.scrapearGoogleNews(query);
  }
}
