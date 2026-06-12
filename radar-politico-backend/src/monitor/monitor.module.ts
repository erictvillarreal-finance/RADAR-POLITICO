import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MonitorService } from './monitor.service';
import { ScraperModule } from '../scraper/scraper.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [ScheduleModule.forRoot(), ScraperModule, AlertsModule],
  providers: [MonitorService],
})
export class MonitorModule {}
