#include <metal_stdlib>
using namespace metal;

struct NBVertex {
    float4 position [[position]];
    float2 uv;
};
struct NBUniforms {
    float2 scale;
    float2 uvMax;
};
vertex NBVertex nb_vertex(uint id [[vertex_id]], constant NBUniforms &u [[buffer(0)]]) {
    const float2 positions[6] = {
        float2(-1, 1), float2(-1, -1), float2(1, -1),
        float2(-1, 1), float2(1, -1), float2(1, 1)
    };
    const float2 uv[6] = {
        float2(0, 0), float2(0, 1), float2(1, 1),
        float2(0, 0), float2(1, 1), float2(1, 0)
    };
    NBVertex out;
    out.position = float4(positions[id] * u.scale, 0, 1);
    out.uv = uv[id] * u.uvMax;
    return out;
}
fragment float4 nb_fragment(NBVertex in [[stage_in]], texture2d<float> frame [[texture(0)]]) {
    constexpr sampler nearestSampler(coord::normalized, address::clamp_to_edge, filter::nearest);
    return float4(frame.sample(nearestSampler, in.uv).rgb, 1);
}
