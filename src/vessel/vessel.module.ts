import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { VesselsController, VisitsController } from './vessel.controller';
import { VesselService } from './vessel.service';

@Module({
  imports: [InventoryModule],
  controllers: [VesselsController, VisitsController],
  providers: [VesselService],
  exports: [VesselService],
})
export class VesselModule {}
