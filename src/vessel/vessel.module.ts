import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';
import { VesselsController, VisitsController } from './vessel.controller';
import { VesselService } from './vessel.service';

@Module({
  imports: [InventoryModule],
  controllers: [VesselsController, VisitsController, PlanningController],
  providers: [VesselService, PlanningService],
  exports: [VesselService, PlanningService],
})
export class VesselModule {}
