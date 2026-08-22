import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';

/**
 * Module for serving the monitoring dashboard UI
 * Provides static file serving for the vanilla HTML/CSS/JS dashboard
 */
@Module({
  controllers: [DashboardController],
})
export class DashboardModule {}
