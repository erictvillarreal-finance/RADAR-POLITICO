import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';
import { AlertsService } from '../alerts/alerts.service';
import Redis from 'ioredis';

const KEYWORDS = [
  'Pemex',
  'Sener Mexico',
  'Juan Carlos Carpio Fragoso',
  'Director General Pemex',
  'Hidrocarburos',
  'Huachicol',
  'Toma Clandestina',
  'Gas Mexico',
  'Diesel Mexico',
  'Gasolina Mexico',
  'Petroleo Mexico',
  'Refineria Cadereyta',
  'Contaminacion Pemex',
  'Desabasto combustible',
  'Robo combustible',
  'Ducto Mexico',
  'Poliducto',
  'Gasoducto Mexico',
  'Pipa combustible',
  'Autotanque',
  'Terminal almacenamiento combustible',
  'TAD Pemex',
  'Gas LP Mexico',
  'Incendio refineria',
  'Explosion ducto',
  'Derrame petroleo',
  'Fuga gas Mexico',
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
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.logger.log('Redis conectado');
  }

  @Cron('0 */30 * * * *')
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
        await new Promise(r => setTimeout(r, 15000));
        const noticias = await this.scraperService.scrapearGoogleNews(keyword);

        for (const noticia of noticias) {
          if (new Date(noticia.fecha) < hace24h) continue;
          const key = 'enviada:' + require('crypto').createHash('md5').update(noticia.url).digest('hex');
          const yaEnviada = await this.redis.get(key);
          if (yaEnviada) continue;
          await this.redis.set(key, '1', 'EX', 86400);
          await this.alertsService.enviarAlerta(noticia);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      this.logger.log('Monitoreo completado');
    } finally {
      this.corriendo = false;
    }
  }
}
