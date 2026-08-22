import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { StateModule } from '../state/state.module.js';
import { ModelsModule } from '../models/models.module.js';

@Module({
  imports: [StateModule, ModelsModule],
  controllers: [AdminController],
})
export class AdminModule {}
