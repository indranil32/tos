import { Module } from '@nestjs/common';
import { EquipmentModule } from '../equipment/equipment.module';
import { InventoryModule } from '../inventory/inventory.module';
import { VesselModule } from '../vessel/vessel.module';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';

@Module({
  imports: [EquipmentModule, InventoryModule, VesselModule],
  controllers: [WorkController],
  providers: [WorkService],
})
export class WorkModule {}
