import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';
import { ScraperModule } from '../scraper/scraper.module';
import { MonitorModule } from '../monitor/monitor.module';

@Module({
  imports: [ScraperModule, MonitorModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
