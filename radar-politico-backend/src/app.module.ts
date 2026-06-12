import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScraperModule } from './scraper/scraper.module';
import { AlertsModule } from './alerts/alerts.module';
import { MonitorModule } from './monitor/monitor.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScraperModule,
    AlertsModule,
    MonitorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
