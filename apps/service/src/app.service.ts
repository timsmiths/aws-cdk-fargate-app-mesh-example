import { Injectable, HttpService } from '@nestjs/common';
import { map } from 'rxjs/operators';
import config from './config';

@Injectable()
export class AppService {
  private metrics = [];
  constructor(private readonly httpService: HttpService) {}
  getHealth(): object {
    return { message: 'ok' };
  }
  getMetrics(): object {
    return this.metrics.reduce((ac, key) => {
      ac[key] = ac[key] >= 0 ? ac[key] + 1 : 0;
      return ac;
    }, {});
  }
  getHello(): object {
    const { MESSAGE, MESSAGE_URL } = config();
    console.log('Has message, ', MESSAGE, MESSAGE_URL);
    if(!MESSAGE_URL) return { message: MESSAGE };
    return this.httpService.get(MESSAGE_URL)
      .pipe(
        map(res => {
          this.metrics.push(res.data.message);
          return {
            message_url: MESSAGE_URL,
            message: res.data,
            metrics: this.getMetrics(),
          }
        }
      )
    )
  }
}
