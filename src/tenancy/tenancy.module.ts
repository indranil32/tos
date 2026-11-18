import { Module } from '@nestjs/common';
import { MasterDataController, PlatformTenantsController } from './tenancy.controller';

@Module({ controllers: [PlatformTenantsController, MasterDataController] })
export class TenancyModule {}
