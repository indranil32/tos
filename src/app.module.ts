import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module';
import { EdiModule } from './edi/edi.module';
import { GateModule } from './gate/gate.module';
import { InventoryModule } from './inventory/inventory.module';
import { PlatformModule } from './platform/platform.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { VesselModule } from './vessel/vessel.module';
import { EquipmentModule } from './equipment/equipment.module';
import { TerminalModule } from './terminal/terminal.module';
import { WorkModule } from './work/work.module';

/**
 * Modular monolith: each module owns its tables and talks to others through services and domain events.
 * Cargo-type modules (break-bulk, RoRo, liquid bulk) plug into the same unit/visit/billing core.
 */
@Module({
  imports: [
    PlatformModule, TenancyModule, TerminalModule, InventoryModule, VesselModule, GateModule, BillingModule, EdiModule,
    EquipmentModule, WorkModule,
  ],
})
export class AppModule {}
