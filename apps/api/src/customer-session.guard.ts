import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Customer, ServiceRequestStore } from './app.service';
import { ServiceRequestRepository } from './service-request.repository';

export type CustomerAuthenticatedRequest = Request & {
  customer: Customer;
};

type CustomerSessionStore = Pick<ServiceRequestStore, 'findCustomerBySession'>;

@Injectable()
export class CustomerSessionGuard implements CanActivate {
  constructor(
    @Inject(ServiceRequestRepository)
    private readonly store: CustomerSessionStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<CustomerAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      if (!request.readableEnded) {
        request.resume();
      }
      await new Promise((resolve) => setImmediate(resolve));
      throw new UnauthorizedException('Bearer token required');
    }

    const customer = await this.store.findCustomerBySession(token);
    if (!customer) {
      if (!request.readableEnded) {
        request.resume();
      }
      await new Promise((resolve) => setImmediate(resolve));
      throw new UnauthorizedException('Unauthorized');
    }
    request.customer = customer;
    return true;
  }
}
