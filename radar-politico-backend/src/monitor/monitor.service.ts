import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';
import { AlertsService } from '../alerts/alerts.service';
import Redis from 'ioredis';

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
export class MonitorService implements OnModuleInit {
  private readonly logger = new Logger(MonitorService.name);
  private corriendo = false;
  private redis: Redis;

  constructor(
    private readonly scraperService: ScraperService,
    private readonly alertsService: AlertsService,
  ) {}

  onModuleInit() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.logger.log('Redis conectado');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitorear() {
    if (this.corriendo) {
      this.logger.warn('Ciclo anterior aun en proceso, saltando...');
      return;
    }
    this.corriendo = true;

    try {
      this.logger.log('Iniciando monitoreo ' + new Date().toLocaleString('es-MX'));
      const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      for (const keyword of KEYWORDS) {
        await new Promise(r => setTimeout(r, 4000));
        const noticias = await this.scraperService.scrapearGoogleNews(keyword);
        for (const noticia of noticias) {
          if (new Date(noticia.fecha) < hace24h) continue;
          const key = 'enviada:' + Buffer.from(noticia.url).toString('base64').slice(0, 40);
          const yaEnviada = await this.redis.get(key);
          if (yaEnviada) continue;
          await this.redis.set(key, '1', 'EX', 86400);
          await this.alertsService.enviarAlerta(noticia);
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      this.logger.log('Monitoreo completado');
    } finally {
      this.corriendo = false;
    }
  }
}
